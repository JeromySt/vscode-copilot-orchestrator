// <copyright file="PlanExporter.cs" company="AiOrchestrator contributors">
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
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Options;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Portability;

/// <summary>
/// Exports a plan into a portable <c>.aioplan</c> archive per §3.20 + §3.31.4.1.
/// Produces a deterministic zip containing <c>manifest.json</c> (shared schema with diagnose),
/// the canonical plan JSON, and optional auxiliary artifacts.
/// </summary>
public sealed class PlanExporter
{
    private static readonly DateTimeOffset DeterministicEpoch = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private readonly IPlanStore store;
#pragma warning disable CA1823, IDE0052
    private readonly IFileSystem fs;
#pragma warning restore CA1823, IDE0052
    private readonly IClock clock;
    private readonly IOptionsMonitor<PortabilityOptions> opts;
    private readonly IPathValidator? pathValidator;

    /// <summary>Initializes a new <see cref="PlanExporter"/>.</summary>
    /// <param name="store">Plan store used to read the source plan.</param>
    /// <param name="fs">File-system abstraction (INV-8).</param>
    /// <param name="clock">Clock used to stamp the manifest when no override is provided.</param>
    /// <param name="opts">Portability options monitor.</param>
    /// <param name="pathValidator">Optional path validator applied to the output path (INV-8).</param>
    public PlanExporter(
        IPlanStore store,
        IFileSystem fs,
        IClock clock,
        IOptionsMonitor<PortabilityOptions> opts,
        IPathValidator? pathValidator = null)
    {
        this.store = store ?? throw new ArgumentNullException(nameof(store));
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.pathValidator = pathValidator;
    }

    /// <summary>Exports the identified plan to <paramref name="outputFile"/>.</summary>
    /// <param name="planId">The plan to export.</param>
    /// <param name="outputFile">Target <c>.aioplan</c> path.</param>
    /// <param name="options">Per-request export flags.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The output path (identical to <paramref name="outputFile"/>).</returns>
    public async ValueTask<AbsolutePath> ExportAsync(
        PlanId planId,
        AbsolutePath outputFile,
        ExportOptions options,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var portOpts = this.opts.CurrentValue;

        if (this.pathValidator is { } pv)
        {
            var dir = Path.GetDirectoryName(outputFile.Value)
                ?? throw new InvalidOperationException("OutputFile must include a directory.");
            pv.AssertSafe(outputFile, new AbsolutePath(dir));
        }

        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan '{planId}' was not found.");

        var projected = ProjectForExport(plan, options);
        var planJson = PlanJson.Serialize(projected);

        var entries = new SortedDictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["plan.json"] = Encoding.UTF8.GetBytes(planJson),
        };

        var createdAt = options.OverrideCreatedAt ?? this.clock.UtcNow;

        var entryMeta = ImmutableDictionary.CreateBuilder<string, PortabilityEntry>(StringComparer.Ordinal);
        foreach (var (p, data) in entries)
        {
            entryMeta[p] = new PortabilityEntry(p, data.Length, Sha256Hex(data));
        }

        var manifestJson = SerializeManifest(
            portOpts.SchemaVersion,
            createdAt,
            portOpts.AioVersion,
            entryMeta.ToImmutable());
        entries["manifest.json"] = Encoding.UTF8.GetBytes(manifestJson);

        var outDir = Path.GetDirectoryName(outputFile.Value);
        if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir))
        {
            _ = Directory.CreateDirectory(outDir);
        }

        WriteZip(outputFile.Value, entries);
        return outputFile;
    }

    internal static PlanModel ProjectForExport(PlanModel plan, ExportOptions options)
    {
        // PORT-6 — strip attempts/transitions when not requested.
        var jobs = new Dictionary<string, JobNode>(plan.Jobs.Count, StringComparer.Ordinal);
        foreach (var (jobId, job) in plan.Jobs)
        {
            var ws = job.WorkSpec;
            if (ws != null && options.RedactPaths)
            {
                ws = new WorkSpec
                {
                    AllowedFolders = ws.AllowedFolders.Select(RedactPath).ToArray(),
                    AllowedUrls = ws.AllowedUrls,
                    CheckCommands = ws.CheckCommands,
                    Instructions = ws.Instructions,
                };
            }

            jobs[jobId] = options.IncludeAttempts
                ? job with { WorkSpec = ws }
                : job with
                {
                    WorkSpec = ws,
                    Attempts = Array.Empty<JobAttempt>(),
                    Transitions = Array.Empty<StateTransition>(),
                };
        }

        return plan with { Jobs = jobs };
    }

    internal static string RedactPath(string raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return raw;
        }

        if (!Path.IsPathRooted(raw))
        {
            return raw;
        }

        // Drive-relative Windows roots: C:\Users\foo\... → <HOME>/...
        var homeCandidates = new[]
        {
            System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile),
            System.Environment.GetEnvironmentVariable("HOME"),
            System.Environment.GetEnvironmentVariable("USERPROFILE"),
        };

        foreach (var home in homeCandidates)
        {
            if (!string.IsNullOrEmpty(home) && raw.StartsWith(home, StringComparison.OrdinalIgnoreCase))
            {
                var rel = raw[home.Length..].TrimStart('\\', '/');
                return "<HOME>/" + rel.Replace('\\', '/');
            }
        }

        // Fallback: strip the root anchor (drive letter or leading slash) to produce a repo-relative-looking path.
        var rooted = raw.Replace('\\', '/');
        var idx = rooted.IndexOf('/', StringComparison.Ordinal);
        if (idx >= 0)
        {
            return rooted[(idx + 1)..];
        }

        return rooted;
    }

    internal static string SerializeManifest(
        Version schemaVersion,
        DateTimeOffset createdAt,
        string aioVersion,
        ImmutableDictionary<string, PortabilityEntry> entries)
    {
        var doc = new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["aioVersion"] = aioVersion,
            ["createdAt"] = createdAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["dotnetRuntimeVersion"] = System.Environment.Version.ToString(),
            ["entries"] = entries
                .OrderBy(e => e.Key, StringComparer.Ordinal)
                .Select(e => new SortedDictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["bytes"] = e.Value.Bytes,
                    ["path"] = e.Value.Path,
                    ["sha256"] = e.Value.Sha256,
                })
                .ToArray(),
            ["kind"] = "plan",
            ["schemaVersion"] = schemaVersion.ToString(),
            ["warnings"] = Array.Empty<string>(),
        };

        return JsonSerializer.Serialize(doc, ManifestJsonOptions);
    }

    private static readonly JsonSerializerOptions ManifestJsonOptions = new()
    {
        WriteIndented = false,
    };

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
            _ = sb.Append(b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }
}

/// <summary>Metadata for a single entry in the portability archive manifest.</summary>
/// <param name="Path">Archive-relative path.</param>
/// <param name="Bytes">Uncompressed size in bytes.</param>
/// <param name="Sha256">Lowercase hex SHA-256 of the entry's bytes.</param>
internal sealed record PortabilityEntry(string Path, long Bytes, string Sha256);
