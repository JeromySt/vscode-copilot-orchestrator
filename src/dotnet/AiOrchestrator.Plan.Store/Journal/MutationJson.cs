// <copyright file="MutationJson.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Canonical JSON serialization for <see cref="PlanMutation"/> journal entries and for
/// computing the content hash that backs RW-2-IDEM conflict detection.
/// </summary>
internal static class MutationJson
{
    private static readonly JsonSerializerOptions PayloadOptions = BuildPayloadOptions();

    /// <summary>Serializes <paramref name="mutation"/>'s payload (the kind-specific fields) to canonical JSON bytes.</summary>
    /// <param name="mutation">The mutation to canonicalize.</param>
    /// <returns>Canonical JSON bytes representing the payload only (excludes Seq/IdemKey/At).</returns>
    public static byte[] CanonicalPayloadBytes(PlanMutation mutation)
    {
        object payload = mutation switch
        {
            JobAdded m => new { kind = "JobAdded", node = m.Node },
            JobRemoved m => new { kind = "JobRemoved", jobId = m.JobIdValue },
            JobDepsUpdated m => new { kind = "JobDepsUpdated", jobId = m.JobIdValue, deps = m.NewDeps.AsEnumerable() },
            JobStatusUpdated m => new { kind = "JobStatusUpdated", jobId = m.JobIdValue, status = m.NewStatus.ToString() },
            JobAttemptRecorded m => new { kind = "JobAttemptRecorded", jobId = m.JobIdValue, attempt = m.Attempt },
            PlanStatusUpdated m => new { kind = "PlanStatusUpdated", status = m.NewStatus.ToString() },
            _ => throw new NotSupportedException($"Unknown mutation kind: {mutation.GetType().FullName}"),
        };

        var json = JsonSerializer.Serialize(payload, PayloadOptions);
        return Encoding.UTF8.GetBytes(json);
    }

    /// <summary>Computes the SHA-256 content hash of a mutation payload (hex-encoded, uppercase).</summary>
    /// <param name="mutation">The mutation.</param>
    /// <returns>The hex-encoded hash.</returns>
    public static string ContentHash(PlanMutation mutation)
    {
        var bytes = CanonicalPayloadBytes(mutation);
        Span<byte> hash = stackalloc byte[32];
        _ = SHA256.HashData(bytes, hash);
        return Convert.ToHexString(hash);
    }

    /// <summary>Serializes a complete journal entry (metadata + payload) as a single NDJSON line.</summary>
    /// <param name="mutation">The mutation.</param>
    /// <param name="contentHash">The precomputed content hash.</param>
    /// <returns>One JSON line (no trailing newline).</returns>
    public static string SerializeEntry(PlanMutation mutation, string contentHash)
    {
        var kind = KindOf(mutation);
        var payloadJson = Encoding.UTF8.GetString(CanonicalPayloadBytes(mutation));
        var sb = new StringBuilder(256);
        sb.Append('{');
        AppendJsonString(sb, "seq");
        sb.Append(':').Append(mutation.Seq.ToString(CultureInfo.InvariantCulture)).Append(',');
        AppendJsonString(sb, "idemKey");
        sb.Append(':');
        AppendJsonString(sb, mutation.IdemKey.Value ?? string.Empty);
        sb.Append(',');
        AppendJsonString(sb, "at");
        sb.Append(':');
        AppendJsonString(sb, mutation.At.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ", CultureInfo.InvariantCulture));
        sb.Append(',');
        AppendJsonString(sb, "kind");
        sb.Append(':');
        AppendJsonString(sb, kind);
        sb.Append(',');
        AppendJsonString(sb, "contentHash");
        sb.Append(':');
        AppendJsonString(sb, contentHash);
        sb.Append(',');
        AppendJsonString(sb, "payload");
        sb.Append(':').Append(payloadJson);
        sb.Append('}');
        return sb.ToString();
    }

    /// <summary>Parses one NDJSON journal line back into a strongly-typed mutation.</summary>
    /// <param name="line">The raw JSON text.</param>
    /// <returns>The deserialized mutation.</returns>
    public static PlanMutation DeserializeEntry(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var seq = root.GetProperty("seq").GetInt64();
        var idem = new IdempotencyKey(root.GetProperty("idemKey").GetString() ?? string.Empty);
        var at = DateTimeOffset.Parse(root.GetProperty("at").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        var kind = root.GetProperty("kind").GetString()!;
        var payload = root.GetProperty("payload");

        switch (kind)
        {
            case "JobAdded":
            {
                var nodeJson = payload.GetProperty("node").GetRawText();
                var node = JsonSerializer.Deserialize<JobNode>(nodeJson, PayloadOptions) ?? new JobNode();
                return new JobAdded(seq, idem, at, node);
            }

            case "JobRemoved":
            {
                var jid = payload.GetProperty("jobId").GetString() ?? string.Empty;
                return new JobRemoved(seq, idem, at, jid);
            }

            case "JobDepsUpdated":
            {
                var jid = payload.GetProperty("jobId").GetString() ?? string.Empty;
                var depsJson = payload.GetProperty("deps");
                var depsBuilder = ImmutableArray.CreateBuilder<string>();
                foreach (var d in depsJson.EnumerateArray())
                {
                    depsBuilder.Add(d.GetString() ?? string.Empty);
                }

                return new JobDepsUpdated(seq, idem, at, jid, depsBuilder.ToImmutable());
            }

            case "JobStatusUpdated":
            {
                var jid = payload.GetProperty("jobId").GetString() ?? string.Empty;
                var statusStr = payload.GetProperty("status").GetString() ?? "Pending";
                var status = Enum.Parse<JobStatus>(statusStr);
                return new JobStatusUpdated(seq, idem, at, jid, status);
            }

            case "JobAttemptRecorded":
            {
                var jid = payload.GetProperty("jobId").GetString() ?? string.Empty;
                var attJson = payload.GetProperty("attempt").GetRawText();
                var attempt = JsonSerializer.Deserialize<JobAttempt>(attJson, PayloadOptions) ?? new JobAttempt();
                return new JobAttemptRecorded(seq, idem, at, jid, attempt);
            }

            case "PlanStatusUpdated":
            {
                var statusStr = payload.GetProperty("status").GetString() ?? "Pending";
                var status = Enum.Parse<PlanStatus>(statusStr);
                return new PlanStatusUpdated(seq, idem, at, status);
            }

            default:
                throw new PlanJournalCorruptedException($"Unknown mutation kind in journal: '{kind}'.");
        }
    }

    /// <summary>Returns the discriminator string for a given concrete mutation type.</summary>
    /// <param name="mutation">The mutation.</param>
    /// <returns>A stable kind discriminator.</returns>
    public static string KindOf(PlanMutation mutation) => mutation switch
    {
        JobAdded => "JobAdded",
        JobRemoved => "JobRemoved",
        JobDepsUpdated => "JobDepsUpdated",
        JobStatusUpdated => "JobStatusUpdated",
        JobAttemptRecorded => "JobAttemptRecorded",
        PlanStatusUpdated => "PlanStatusUpdated",
        _ => throw new NotSupportedException($"Unknown mutation kind: {mutation.GetType().FullName}"),
    };

    private static JsonSerializerOptions BuildPayloadOptions()
    {
        var opts = new JsonSerializerOptions
        {
            WriteIndented = false,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters =
            {
                new JsonStringEnumConverter(JsonNamingPolicy.CamelCase),
            },
        };

        opts.TypeInfoResolver = new DefaultJsonTypeInfoResolver
        {
            Modifiers = { SortPropertiesAlphabetically },
        };

        return opts;
    }

    private static void SortPropertiesAlphabetically(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object)
        {
            return;
        }

        var sorted = typeInfo.Properties
            .OrderBy(static p => p.Name, StringComparer.Ordinal)
            .ToArray();

        typeInfo.Properties.Clear();
        foreach (var p in sorted)
        {
            typeInfo.Properties.Add(p);
        }
    }

    private static void AppendJsonString(StringBuilder sb, string value)
    {
        sb.Append('"');
        foreach (var c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
    }
}
