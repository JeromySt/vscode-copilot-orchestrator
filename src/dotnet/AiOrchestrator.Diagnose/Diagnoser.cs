// <copyright file="Diagnoser.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Audit;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Diagnose.Events;
using AiOrchestrator.Diagnose.Pseudonymizer;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Diagnose;

/// <summary>
/// Produces portable <c>.aiodiag</c> archives per spec §3.18 + §3.31.1.3.
/// Redacts and pseudonymizes all text content before packaging.
/// </summary>
public sealed class Diagnoser
{
    private static readonly DateTimeOffset DeterministicEpoch = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private readonly IPlanStore planStore;
    private readonly IEventReader events;
    private readonly AiOrchestrator.Audit.IAuditLog audit;
    private readonly IRedactor redactor;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IOptionsMonitor<DiagnoseOptions> opts;
    private readonly IPathValidator? pathValidator;
    private readonly IDiagnoseObserver? observer;

    /// <summary>Initializes a new <see cref="Diagnoser"/>.</summary>
    /// <param name="planStore">Source of plan state.</param>
    /// <param name="events">Source of events.</param>
    /// <param name="audit">Source of audit records.</param>
    /// <param name="redactor">Secret redactor (INV-5).</param>
    /// <param name="fs">File system abstraction.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="pathValidator">Optional path validator (INV-9).</param>
    /// <param name="observer">Optional observer that receives <see cref="DiagnoseBundleProduced"/> events (INV-6).</param>
    public Diagnoser(
        IPlanStore planStore,
        IEventReader events,
        AiOrchestrator.Audit.IAuditLog audit,
        IRedactor redactor,
        IFileSystem fs,
        IClock clock,
        IOptionsMonitor<DiagnoseOptions> opts,
        IPathValidator? pathValidator = null,
        IDiagnoseObserver? observer = null)
    {
        this.planStore = planStore ?? throw new ArgumentNullException(nameof(planStore));
        this.events = events ?? throw new ArgumentNullException(nameof(events));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.redactor = redactor ?? throw new ArgumentNullException(nameof(redactor));
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.pathValidator = pathValidator;
        this.observer = observer;
    }

    /// <summary>Produces the requested bundle and returns its location.</summary>
    /// <param name="request">The diagnose request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The output path (identical to <see cref="DiagnoseRequest.OutputPath"/>).</returns>
    public async ValueTask<AbsolutePath> ProduceBundleAsync(DiagnoseRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var options = this.opts.CurrentValue;

        var mode = request.PseudonymizationMode ?? options.PseudonymizationMode;
        var allowPii = request.AllowPii || options.AllowPii;
        if (mode == PseudonymizationMode.Off && !allowPii)
        {
            throw new InvalidOperationException(
                "PseudonymizationMode.Off is forbidden unless --allow-pii was explicitly passed (INV-4 / DIAG-RECIP-3).");
        }

        // INV-9 — validate the output path if a validator was provided. Validator asserts
        // a child-under-root relationship; we pass the directory as its own root, so the
        // check fails only when the path is non-absolute / contains traversal that resolves outside.
        if (this.pathValidator is { } pv)
        {
            var dir = Path.GetDirectoryName(request.OutputPath.Value)
                ?? throw new InvalidOperationException("OutputPath must include a directory.");
            pv.AssertSafe(request.OutputPath, new AbsolutePath(dir));
        }

        byte[]? recipientPubKey = null;
        string? recipientFp = null;
        if (mode == PseudonymizationMode.Reversible)
        {
            if (string.IsNullOrEmpty(request.Recipient))
            {
                throw new InvalidOperationException("Reversible mode requires Recipient fingerprint (INV-3 / DIAG-RECIP-2).");
            }

            if (!options.RecipientTrustStore.TryGetValue(request.Recipient, out var pub))
            {
                throw new InvalidOperationException(
                    $"Reversible mode requires recipient '{request.Recipient}' to exist in the trust store (INV-3).");
            }

            recipientPubKey = pub;
            recipientFp = request.Recipient;
        }

        var warnings = new List<string>();
        if (mode == PseudonymizationMode.Off && allowPii)
        {
            warnings.Add("allow-pii flag was set; raw PII preserved.");
        }

        if (options.IncludeProcessEnv)
        {
            warnings.Add("Process environment variables were included; may contain tokens (INV-7).");
        }

        var salt = ComputeSalt(request, mode);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        // Build per-entry content.
        var entries = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);

        // plan.json — only when a plan was specified.
        var planJson = await this.BuildPlanJsonAsync(request.PlanId, mode, pseudonymizer, ct).ConfigureAwait(false);
        entries["plan.json"] = Encoding.UTF8.GetBytes(planJson);

        // events.jsonl — drained from IEventReader within the window.
        var eventsJsonl = await this.BuildEventsJsonlAsync(request, options, mode, pseudonymizer, ct).ConfigureAwait(false);
        entries["events.jsonl"] = Encoding.UTF8.GetBytes(eventsJsonl);

        // audit.jsonl — one line per record.
        if (options.IncludeAuditLog)
        {
            var auditJsonl = await this.BuildAuditJsonlAsync(mode, pseudonymizer, ct).ConfigureAwait(false);
            entries["audit.jsonl"] = Encoding.UTF8.GetBytes(auditJsonl);
        }

        // host.json — OS, runtime, AIO version.
        entries["host.json"] = Encoding.UTF8.GetBytes(this.BuildHostJson(options, mode, pseudonymizer));

        if (options.IncludeProcessEnv)
        {
            entries["env.json"] = Encoding.UTF8.GetBytes(BuildEnvJson(mode, pseudonymizer));
        }

        if (mode == PseudonymizationMode.Reversible && recipientFp != null && recipientPubKey != null)
        {
            var mapping = table.GetSortedForward();
            entries["mapping.encrypted.bin"] = MappingTableEncryptor.Encrypt(mapping, recipientFp, recipientPubKey);
        }

        var createdAt = request.OverrideCreatedAt ?? this.clock.UtcNow;

        // Compute manifest last so it can reference all other entries' hashes.
        var entryMeta = ImmutableDictionary.CreateBuilder<string, BundleEntry>(StringComparer.Ordinal);
        foreach (var (path, data) in entries)
        {
            entryMeta[path] = new BundleEntry { Path = path, Bytes = data.Length, Sha256 = Sha256Hex(data) };
        }

        var manifest = new BundleManifest
        {
            SchemaVersion = new Version(1, 0),
            CreatedAt = createdAt,
            PseudonymizationMode = mode,
            RecipientPubKeyFingerprint = recipientFp,
            Entries = entryMeta.ToImmutable(),
            DotnetRuntimeVersion = System.Environment.Version.ToString(),
            AioVersion = options.AioVersion,
            Kind = "diagnose",
            Warnings = warnings,
        };

        var manifestJson = SerializeManifest(manifest);
        entries["manifest.json"] = Encoding.UTF8.GetBytes(manifestJson);

        // Pack the archive — deterministic order, fixed timestamps, no compression.
        var outputPath = request.OutputPath;
        var outDir = Path.GetDirectoryName(outputPath.Value);
        if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir))
        {
            Directory.CreateDirectory(outDir);
        }

        WriteZip(outputPath.Value, entries);

        // INV-6: emit the audit record & observer event.
        var manifestSha = Sha256Hex(entries["manifest.json"]);
        var produced = new DiagnoseBundleProduced
        {
            PlanId = request.PlanId,
            OutputPath = outputPath.Value,
            ManifestSha256 = manifestSha,
            PseudonymizationMode = mode,
            RecipientPubKeyFingerprint = recipientFp,
            ProducedAt = createdAt,
        };

        await this.EmitAuditAsync(produced, ct).ConfigureAwait(false);
        this.observer?.OnBundleProduced(produced);

        return outputPath;
    }

    private static byte[] ComputeSalt(DiagnoseRequest request, PseudonymizationMode mode)
    {
        // Deterministic salt: bundled from the request's plan id + mode + recipient so that
        // two bundles with the same inputs produce byte-identical pseudonyms (INV-8).
        var material = Encoding.UTF8.GetBytes($"{request.PlanId?.ToString() ?? "-"}|{mode}|{request.Recipient ?? "-"}");
        return SHA256.HashData(material);
    }

    private async ValueTask<string> BuildPlanJsonAsync(
        PlanId? planId,
        PseudonymizationMode mode,
        IPseudonymizer pseudonymizer,
        CancellationToken ct)
    {
        if (planId is null)
        {
            return "{}";
        }

        var plan = await this.planStore.LoadAsync(planId.Value, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return "{}";
        }

        var raw = JsonSerializer.Serialize(plan, DiagnoseJson.Options);
        return await this.PostProcessAsync(raw, mode, pseudonymizer, ct).ConfigureAwait(false);
    }

    private async ValueTask<string> BuildEventsJsonlAsync(
        DiagnoseRequest request,
        DiagnoseOptions options,
        PseudonymizationMode mode,
        IPseudonymizer pseudonymizer,
        CancellationToken ct)
    {
        var window = request.EventLogWindow ?? options.EventLogWindow;
        var createdAt = request.OverrideCreatedAt ?? this.clock.UtcNow;
        var windowStart = createdAt - window;

        var collected = new List<EventEnvelope>();
        var filter = new EventFilter
        {
            SubscribingPrincipal = new AuthContext
            {
                PrincipalId = "diagnose",
                DisplayName = "Diagnose",
                Scopes = ImmutableArray<string>.Empty,
            },
            PlanId = request.PlanId,
        };

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(options.EventReaderIdleTimeout);
        try
        {
            await foreach (var env in this.events.ReadReplayAndLiveAsync(filter, linked.Token).ConfigureAwait(false))
            {
                if (env.OccurredAtUtc >= windowStart && env.OccurredAtUtc <= createdAt)
                {
                    collected.Add(env);
                }

                linked.CancelAfter(options.EventReaderIdleTimeout);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Expected: idle timeout reached — treat as end-of-stream.
        }

        collected.Sort((a, b) => a.RecordSeq.CompareTo(b.RecordSeq));

        var sb = new StringBuilder();
        foreach (var env in collected)
        {
            var raw = JsonSerializer.Serialize(env, DiagnoseJson.Options);
            sb.Append(await this.PostProcessAsync(raw, mode, pseudonymizer, ct).ConfigureAwait(false));
            sb.Append('\n');
        }

        return sb.ToString();
    }

    private async ValueTask<string> BuildAuditJsonlAsync(
        PseudonymizationMode mode,
        IPseudonymizer pseudonymizer,
        CancellationToken ct)
    {
        var sb = new StringBuilder();
        await foreach (var rec in this.audit.ReadAsync(ct).ConfigureAwait(false))
        {
            var raw = JsonSerializer.Serialize(rec, DiagnoseJson.Options);
            sb.Append(await this.PostProcessAsync(raw, mode, pseudonymizer, ct).ConfigureAwait(false));
            sb.Append('\n');
        }

        return sb.ToString();
    }

    private string BuildHostJson(DiagnoseOptions options, PseudonymizationMode mode, IPseudonymizer pseudonymizer)
    {
        var hostName = System.Environment.MachineName;
        var userName = System.Environment.UserName;
        if (mode is PseudonymizationMode.Anonymous or PseudonymizationMode.Reversible)
        {
            hostName = pseudonymizer.PseudonymizeAsync(hostName, PseudonymKind.Hostname, CancellationToken.None).AsTask().GetAwaiter().GetResult();
            userName = pseudonymizer.PseudonymizeAsync(userName, PseudonymKind.UserName, CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }

        var doc = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["aioVersion"] = options.AioVersion,
            ["dotnetRuntimeVersion"] = System.Environment.Version.ToString(),
            ["hostName"] = hostName,
            ["osPlatform"] = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            ["osArchitecture"] = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
            ["processorCount"] = System.Environment.ProcessorCount,
            ["userName"] = userName,
        };

        return this.redactor.Redact(JsonSerializer.Serialize(doc, DiagnoseJson.Options));
    }

    private static string BuildEnvJson(PseudonymizationMode mode, IPseudonymizer pseudonymizer)
    {
        var raw = System.Environment.GetEnvironmentVariables();
        var dict = new SortedDictionary<string, string?>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry de in raw)
        {
            dict[(string)de.Key] = de.Value?.ToString();
        }

        return JsonSerializer.Serialize(dict, DiagnoseJson.Options);
    }

    private async ValueTask<string> PostProcessAsync(
        string raw,
        PseudonymizationMode mode,
        IPseudonymizer pseudonymizer,
        CancellationToken ct)
    {
        // INV-5 — redactor runs BEFORE pseudonymizer.
        var redacted = this.redactor.Redact(raw);
        if (mode == PseudonymizationMode.Off)
        {
            return redacted;
        }

        return await PseudonymizeTextAsync(redacted, pseudonymizer, ct).ConfigureAwait(false);
    }

    private static async ValueTask<string> PseudonymizeTextAsync(string text, IPseudonymizer pseudonymizer, CancellationToken ct)
    {
        // Lightweight pass: pseudonymize obvious email addresses and IP addresses.
        // Anything else (paths, hostnames) is expected to be pseudonymized by callers
        // that know the identifier kind (e.g., host.json).
        var sb = new StringBuilder(text.Length);
        var emailPattern = new System.Text.RegularExpressions.Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", System.Text.RegularExpressions.RegexOptions.Compiled);
        var ipPattern = new System.Text.RegularExpressions.Regex("\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", System.Text.RegularExpressions.RegexOptions.Compiled);

        var lastIndex = 0;
        var combined = emailPattern.Matches(text).Cast<System.Text.RegularExpressions.Match>()
            .Concat(ipPattern.Matches(text).Cast<System.Text.RegularExpressions.Match>())
            .OrderBy(m => m.Index)
            .ToList();

        var replacedRanges = new List<(int Start, int End)>();
        foreach (var m in combined)
        {
            if (replacedRanges.Any(r => m.Index < r.End && m.Index + m.Length > r.Start))
            {
                continue;
            }

            if (m.Index < lastIndex)
            {
                continue;
            }

            sb.Append(text, lastIndex, m.Index - lastIndex);
            var kind = m.Value.Contains('@', StringComparison.Ordinal) ? PseudonymKind.EmailAddress : PseudonymKind.IpAddress;
            var replaced = await pseudonymizer.PseudonymizeAsync(m.Value, kind, ct).ConfigureAwait(false);
            sb.Append(replaced);
            lastIndex = m.Index + m.Length;
            replacedRanges.Add((m.Index, m.Index + m.Length));
        }

        sb.Append(text, lastIndex, text.Length - lastIndex);
        return sb.ToString();
    }

    private async ValueTask EmitAuditAsync(DiagnoseBundleProduced produced, CancellationToken ct)
    {
        try
        {
            var content = JsonSerializer.Serialize(produced, DiagnoseJson.Options);
            var rec = new AiOrchestrator.Audit.AuditRecord
            {
                EventType = "diagnose.bundle_produced",
                At = produced.ProducedAt,
                Principal = new AuthContext
                {
                    PrincipalId = "diagnose",
                    DisplayName = "Diagnose",
                    Scopes = ImmutableArray<string>.Empty,
                },
                ContentJson = content,
                ResourceRefs = ImmutableArray.Create(produced.OutputPath),
            };
            await this.audit.AppendAsync(rec, ct).ConfigureAwait(false);
        }
        catch
        {
            // Audit emission is best-effort; failure must not prevent bundle delivery.
        }
    }

    private static string SerializeManifest(BundleManifest m)
    {
        // Serialize manually to guarantee key order (deterministic output — INV-8).
        var doc = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["aioVersion"] = m.AioVersion,
            ["createdAt"] = m.CreatedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["dotnetRuntimeVersion"] = m.DotnetRuntimeVersion,
            ["entries"] = m.Entries
                .OrderBy(e => e.Key, StringComparer.Ordinal)
                .Select(e => new SortedDictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["bytes"] = e.Value.Bytes,
                    ["path"] = e.Value.Path,
                    ["sha256"] = e.Value.Sha256,
                })
                .ToArray(),
            ["kind"] = m.Kind,
            ["pseudonymizationMode"] = m.PseudonymizationMode.ToString(),
            ["recipientPubKeyFingerprint"] = m.RecipientPubKeyFingerprint,
            ["schemaVersion"] = m.SchemaVersion.ToString(),
            ["warnings"] = m.Warnings.ToArray(),
        };

        return JsonSerializer.Serialize(doc, DiagnoseJson.Options);
    }

    private static void WriteZip(string path, SortedDictionary<string, byte[]> entries)
    {
        using var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        using var zip = new ZipArchive(fs, ZipArchiveMode.Create, leaveOpen: false);

        foreach (var (name, data) in entries)
        {
            var entry = zip.CreateEntry(name, CompressionLevel.NoCompression);
            entry.LastWriteTime = DeterministicEpoch;
            using var s = entry.Open();
            s.Write(data, 0, data.Length);
        }
    }

    private static string Sha256Hex(byte[] data)
    {
        var hash = SHA256.HashData(data);
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            sb.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }
}
