// <copyright file="PlanImporter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.IO.Compression;
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

/// <summary>Materializes a <c>.aioplan</c> archive into a plan in the <see cref="IPlanStore"/>.</summary>
public sealed class PlanImporter
{
    private readonly IPlanStore store;
#pragma warning disable CA1823, IDE0052
    private readonly IFileSystem fs;
    private readonly IClock clock;
#pragma warning restore CA1823, IDE0052
    private readonly IOptionsMonitor<PortabilityOptions> opts;
    private readonly IPathValidator? pathValidator;

    /// <summary>Initializes a new <see cref="PlanImporter"/>.</summary>
    /// <param name="store">Plan store used as the destination.</param>
    /// <param name="fs">File-system abstraction (INV-8).</param>
    /// <param name="clock">Clock.</param>
    /// <param name="opts">Portability options monitor.</param>
    /// <param name="pathValidator">Optional path validator applied to the input path (INV-8).</param>
    public PlanImporter(
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

    /// <summary>Imports the archive located at <paramref name="inputFile"/>.</summary>
    /// <param name="inputFile">Path of the <c>.aioplan</c> archive.</param>
    /// <param name="options">Per-request import options.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The <see cref="PlanId"/> assigned to the imported plan.</returns>
    public async ValueTask<PlanId> ImportAsync(
        AbsolutePath inputFile,
        ImportOptions options,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var portOpts = this.opts.CurrentValue;

        if (this.pathValidator is { } pv)
        {
            var dir = Path.GetDirectoryName(inputFile.Value)
                ?? throw new InvalidOperationException("InputFile must include a directory.");
            pv.AssertSafe(inputFile, new AbsolutePath(dir));
        }

        var archive = LoadArchive(inputFile.Value);

        // PORT-4 — schema version validation.
        if (archive.SchemaVersion.Major != portOpts.SchemaVersion.Major)
        {
            throw new PortabilitySchemaMismatchException(
                $"Archive schema {archive.SchemaVersion} is incompatible with runtime {portOpts.SchemaVersion}.")
            {
                Expected = portOpts.SchemaVersion,
                Actual = archive.SchemaVersion,
            };
        }

        var plan = archive.Plan;

        // PORT-5 — conflict policy.
        if (PlanId.TryParse(plan.Id, out var archivedId))
        {
            var existing = await this.store.LoadAsync(archivedId, ct).ConfigureAwait(false);
            if (existing != null)
            {
                switch (options.IfPlanIdExists)
                {
                    case ImportConflictPolicy.Reject:
                        throw new ImportConflictException(
                            $"Plan '{archivedId}' already exists; policy=Reject.")
                        {
                            ExistingPlanId = archivedId,
                            ExistingStatus = existing.Status,
                        };

                    case ImportConflictPolicy.OverwriteIfArchived:
                        if (existing.Status != PlanStatus.Archived)
                        {
                            throw new ImportConflictException(
                                $"Plan '{archivedId}' exists with status {existing.Status}; OverwriteIfArchived requires {PlanStatus.Archived}.")
                            {
                                ExistingPlanId = archivedId,
                                ExistingStatus = existing.Status,
                            };
                        }

                        break;

                    case ImportConflictPolicy.GenerateNewId:
                    default:
                        // Fall through — CreateAsync will assign a fresh id.
                        break;
                }
            }
        }

        if (!string.IsNullOrEmpty(options.OverridePlanName))
        {
            plan = plan with { Name = options.OverridePlanName! };
        }

        var newId = await this.store.CreateAsync(plan, IdempotencyKey.FromGuid(Guid.NewGuid()), ct).ConfigureAwait(false);
        return newId;
    }

    /// <summary>Loads an archive from disk without materializing it in a store.</summary>
    /// <param name="inputFile">Archive path.</param>
    /// <returns>The parsed <see cref="PortabilityArchive"/>.</returns>
    public static PortabilityArchive Load(AbsolutePath inputFile) => LoadArchive(inputFile.Value);

    internal static PortabilityArchive LoadArchive(string path)
    {
        using var zip = ZipFile.OpenRead(path);

        var manifestEntry = zip.GetEntry("manifest.json")
            ?? throw new InvalidDataException("Archive is missing manifest.json.");
        var planEntry = zip.GetEntry("plan.json")
            ?? throw new InvalidDataException("Archive is missing plan.json.");

        var manifestJson = ReadAllText(manifestEntry);
        var planJson = ReadAllText(planEntry);

        using var doc = JsonDocument.Parse(manifestJson);
        var root = doc.RootElement;

        var schemaStr = root.GetProperty("schemaVersion").GetString()
            ?? throw new InvalidDataException("manifest.schemaVersion missing.");
        var schema = Version.Parse(schemaStr);

        var createdAtStr = root.GetProperty("createdAt").GetString()
            ?? throw new InvalidDataException("manifest.createdAt missing.");
        var createdAt = DateTimeOffset.Parse(createdAtStr, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind);

        var aioVersion = root.TryGetProperty("aioVersion", out var av) ? av.GetString() ?? string.Empty : string.Empty;

        var kind = root.TryGetProperty("kind", out var kElem) ? kElem.GetString() : null;
        if (kind != null && !string.Equals(kind, "plan", StringComparison.Ordinal))
        {
            throw new InvalidDataException($"Unexpected manifest kind '{kind}'; expected 'plan'.");
        }

        var plan = PlanJson.Deserialize(planJson)
            ?? throw new InvalidDataException("Could not deserialize plan.json.");

        var artifactsBuilder = ImmutableDictionary.CreateBuilder<string, byte[]>(StringComparer.Ordinal);
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName == "manifest.json" || entry.FullName == "plan.json")
            {
                continue;
            }

            using var s = entry.Open();
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            artifactsBuilder[entry.FullName] = ms.ToArray();
        }

        return new PortabilityArchive
        {
            SchemaVersion = schema,
            CreatedAt = createdAt,
            AioVersion = aioVersion,
            Plan = plan,
            Artifacts = artifactsBuilder.ToImmutable(),
        };
    }

    private static string ReadAllText(ZipArchiveEntry entry)
    {
        using var s = entry.Open();
        using var sr = new StreamReader(s, Encoding.UTF8);
        return sr.ReadToEnd();
    }
}
