// <copyright file="PortabilityContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Portability;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Options;
using Xunit;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Portability.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class PortabilityContractTests : IDisposable
{
    private readonly string root;

    public PortabilityContractTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "port-tests", Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.root))
            {
                Directory.Delete(this.root, recursive: true);
            }
        }
        catch
        {
            // best effort
        }
    }

    [Fact]
    [ContractTest("PORT-1")]
    public async Task PORT_1_BundleSharesSchemaWithDiagnose()
    {
        var store = this.MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var exporter = this.MakeExporter(store);
        var outputPath = this.MakeOutput("plan.aioplan");

        await exporter.ExportAsync(
            planId,
            outputPath,
            new ExportOptions { OverrideCreatedAt = FixedTime },
            CancellationToken.None);

        using var archive = ZipFile.OpenRead(outputPath.Value);
        var manifestEntry = archive.GetEntry("manifest.json")!;
        using var s = manifestEntry.Open();
        using var doc = JsonDocument.Parse(s);
        var root = doc.RootElement;

        // INV-1: shared schema keys with the diagnose manifest.
        foreach (var required in new[] { "aioVersion", "createdAt", "dotnetRuntimeVersion", "entries", "kind", "schemaVersion", "warnings" })
        {
            Assert.True(root.TryGetProperty(required, out _), $"manifest must expose shared key '{required}'");
        }

        Assert.Equal("plan", root.GetProperty("kind").GetString());
        Assert.Equal("1.0", root.GetProperty("schemaVersion").GetString());
    }

    [Fact]
    [ContractTest("PORT-2")]
    public async Task PORT_2_PlanContentDeterministic()
    {
        var store = this.MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var exporter = this.MakeExporter(store);
        var p1 = this.MakeOutput("det1.aioplan");
        var p2 = this.MakeOutput("det2.aioplan");

        var options = new ExportOptions { OverrideCreatedAt = FixedTime };
        await exporter.ExportAsync(planId, p1, options, CancellationToken.None);
        await exporter.ExportAsync(planId, p2, options, CancellationToken.None);

        var plan1 = ExtractText(p1.Value, "plan.json");
        var plan2 = ExtractText(p2.Value, "plan.json");
        Assert.Equal(plan2, plan1);
    }

    [Fact]
    [ContractTest("PORT-3")]
    public async Task PORT_3_AbsolutePathsRedacted()
    {
        var store = this.MakeStore();
        var absolutePath = OperatingSystem.IsWindows() ? @"C:\src\repo\foo" : "/opt/repo/foo";
        var plan = new PlanModel
        {
            Name = "path-plan",
            Status = PlanStatus.Pending,
            Jobs = new Dictionary<string, JobNode>
            {
                ["j1"] = new JobNode
                {
                    Id = "j1",
                    Title = "t",
                    WorkSpec = new WorkSpec { AllowedFolders = new[] { absolutePath } },
                },
            },
        };
        var planId = await store.CreateAsync(plan, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var exporter = this.MakeExporter(store);
        var outputPath = this.MakeOutput("red.aioplan");

        await exporter.ExportAsync(
            planId,
            outputPath,
            new ExportOptions { RedactPaths = true, OverrideCreatedAt = FixedTime },
            CancellationToken.None);

        var planJson = ExtractText(outputPath.Value, "plan.json");
        Assert.DoesNotContain(absolutePath, planJson);
    }

    [Fact]
    [ContractTest("PORT-4")]
    public async Task PORT_4_SchemaMismatchThrows()
    {
        var store = this.MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var exporter = this.MakeExporter(store);
        var outputPath = this.MakeOutput("old.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        // Rewrite the manifest to declare a future major schema version that the importer rejects.
        RewriteArchive(outputPath.Value, m => m.Replace("\"schemaVersion\":\"1.0\"", "\"schemaVersion\":\"2.0\""));

        var store2 = this.MakeStore("dest");
        var importer = this.MakeImporter(store2);
        var act = async () => await importer.ImportAsync(outputPath, new ImportOptions(), CancellationToken.None);
        await Assert.ThrowsAsync<PortabilitySchemaMismatchException>(act);
    }

    [Fact]
    [ContractTest("PORT-5-NEWID")]
    public async Task PORT_5_GenerateNewIdOnConflict()
    {
        var srcStore = this.MakeStore();
        var planId = await CreateSamplePlanAsync(srcStore);
        var exporter = this.MakeExporter(srcStore);
        var outputPath = this.MakeOutput("dup.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        // Re-import into the SAME store: policy default generates a fresh id.
        var importer = this.MakeImporter(srcStore);
        var newId = await importer.ImportAsync(outputPath, new ImportOptions(), CancellationToken.None);
        Assert.NotEqual(planId, newId);

        var loaded = await srcStore.LoadAsync(newId, CancellationToken.None);
        Assert.NotNull(loaded);
    }

    [Fact]
    [ContractTest("PORT-5-REJECT")]
    public async Task PORT_5_RejectOnConflict()
    {
        var srcStore = this.MakeStore();
        var planId = await CreateSamplePlanAsync(srcStore);
        var exporter = this.MakeExporter(srcStore);
        var outputPath = this.MakeOutput("rej.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        var importer = this.MakeImporter(srcStore);
        var act = async () => await importer.ImportAsync(
            outputPath,
            new ImportOptions { IfPlanIdExists = ImportConflictPolicy.Reject },
            CancellationToken.None);

        var ex = await Assert.ThrowsAsync<ImportConflictException>(act);
        Assert.Equal(planId, ex.ExistingPlanId);
    }

    [Fact]
    [ContractTest("PORT-5-OVR")]
    public async Task PORT_5_OverwriteIfArchivedOnly()
    {
        var srcStore = this.MakeStore();
        // Existing plan is Pending — not Archived — so OverwriteIfArchived must throw.
        var planId = await CreateSamplePlanAsync(srcStore);
        var exporter = this.MakeExporter(srcStore);
        var outputPath = this.MakeOutput("ovr.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        var importer = this.MakeImporter(srcStore);
        var act = async () => await importer.ImportAsync(
            outputPath,
            new ImportOptions { IfPlanIdExists = ImportConflictPolicy.OverwriteIfArchived },
            CancellationToken.None);
        var ex = await Assert.ThrowsAsync<ImportConflictException>(act);
        Assert.Equal(PlanStatus.Pending, ex.ExistingStatus);

        // Now store a plan pre-marked as Archived in a separate store and import succeeds.
        var archivedStore = this.MakeStore("archived");
        var archivedId = await archivedStore.CreateAsync(
            new PlanModel { Name = "a", Status = PlanStatus.Archived },
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        // Re-export with the archived id embedded in plan.json.
        var archivedOutput = this.MakeOutput("archived.aioplan");
        var exporter2 = this.MakeExporter(archivedStore);
        await exporter2.ExportAsync(archivedId, archivedOutput, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        var importer2 = this.MakeImporter(archivedStore);
        var newId = await importer2.ImportAsync(
            archivedOutput,
            new ImportOptions { IfPlanIdExists = ImportConflictPolicy.OverwriteIfArchived },
            CancellationToken.None);
        Assert.NotEqual(default(PlanId), newId);
    }

    [Fact]
    [ContractTest("PORT-6")]
    public async Task PORT_6_AttemptsStrippedWhenFlag()
    {
        var store = this.MakeStore();
        var plan = new PlanModel
        {
            Name = "with-attempts",
            Status = PlanStatus.Pending,
            Jobs = new Dictionary<string, JobNode>
            {
                ["j1"] = new JobNode
                {
                    Id = "j1",
                    Title = "t",
                    Attempts = new[]
                    {
                        new JobAttempt { AttemptNumber = 1, StartedAt = FixedTime, Status = JobStatus.Succeeded },
                    },
                    Transitions = new[]
                    {
                        new StateTransition { From = JobStatus.Pending, To = JobStatus.Succeeded, OccurredAt = FixedTime },
                    },
                },
            },
        };
        var planId = await store.CreateAsync(plan, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var exporter = this.MakeExporter(store);

        // Default (IncludeAttempts = false) → stripped.
        var stripped = this.MakeOutput("strip.aioplan");
        await exporter.ExportAsync(planId, stripped, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);
        var strippedJson = ExtractText(stripped.Value, "plan.json");
        Assert.DoesNotContain("\"attemptNumber\"", strippedJson);

        // With flag → retained.
        var kept = this.MakeOutput("keep.aioplan");
        await exporter.ExportAsync(planId, kept, new ExportOptions { IncludeAttempts = true, OverrideCreatedAt = FixedTime }, CancellationToken.None);
        var keptJson = ExtractText(kept.Value, "plan.json");
        Assert.Contains("\"attemptNumber\"", keptJson);
    }

    [Fact]
    [ContractTest("PORT-RT")]
    public async Task PORT_ROUNDTRIP_BitIdentical()
    {
        var srcStore = this.MakeStore("rt-src");
        var planId = await CreateSamplePlanAsync(srcStore);
        var exporter = this.MakeExporter(srcStore);
        var first = this.MakeOutput("rt1.aioplan");
        await exporter.ExportAsync(planId, first, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        // Import into a fresh store, then re-export.
        var dstStore = this.MakeStore("rt-dst");
        var importer = this.MakeImporter(dstStore);
        var newId = await importer.ImportAsync(first, new ImportOptions(), CancellationToken.None);

        var exporter2 = this.MakeExporter(dstStore);
        var second = this.MakeOutput("rt2.aioplan");
        await exporter2.ExportAsync(newId, second, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        var plan1 = ExtractText(first.Value, "plan.json");
        var plan2 = ExtractText(second.Value, "plan.json");

        // Allow only the plan id to differ between round-trips (the new store assigns a fresh id).
        var normalized1 = ReplacePlanId(plan1);
        var normalized2 = ReplacePlanId(plan2);
        Assert.Equal(normalized1, normalized2);
    }

    [Fact]
    public void ConstructorGuards_ThrowOnNullDependencies()
    {
        var store = this.MakeStore();
        var fs = new NullFileSystem();
        var clock = new InMemoryClock(FixedTime);
        var opts = new StaticOptions<PortabilityOptions>(new PortabilityOptions());

        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanExporter(null!, fs, clock, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanExporter(store, null!, clock, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanExporter(store, fs, null!, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanExporter(store, fs, clock, null!))));

        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanImporter(null!, fs, clock, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanImporter(store, null!, clock, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanImporter(store, fs, null!, opts))));
        Assert.Throws<ArgumentNullException>(((Action)(() => new PlanImporter(store, fs, clock, null!))));
    }

    [Fact]
    public void RedactPath_HandlesEdgeCases()
    {
        var redactPath = typeof(PlanExporter)
            .GetMethod("RedactPath", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        Assert.Equal(string.Empty, (string)redactPath.Invoke(null, new object?[] { string.Empty })!);
        Assert.Equal("relative/path", (string)redactPath.Invoke(null, new object?[] { "relative/path" })!);
    }

    [Fact]
    public async Task Import_OverridePlanName_IsApplied()
    {
        var srcStore = this.MakeStore("rename-src");
        var planId = await CreateSamplePlanAsync(srcStore);
        var exporter = this.MakeExporter(srcStore);
        var outputPath = this.MakeOutput("rename.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        var dstStore = this.MakeStore("rename-dst");
        var importer = this.MakeImporter(dstStore);
        var newId = await importer.ImportAsync(
            outputPath,
            new ImportOptions { OverridePlanName = "renamed!" },
            CancellationToken.None);

        var loaded = await dstStore.LoadAsync(newId, CancellationToken.None);
        Assert.Equal("renamed!", loaded!.Name);
    }

    [Fact]
    public async Task Import_MissingManifest_Throws()
    {
        var p = this.MakeOutput("no-manifest.aioplan");
        using (var fs = new FileStream(p.Value, FileMode.Create))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            var e = zip.CreateEntry("plan.json");
            using var w = new StreamWriter(e.Open());
            await w.WriteAsync("{}");
        }

        var act = () => PlanImporter.Load(p);
        Assert.Throws<InvalidDataException>(act);
    }

    [Fact]
    public async Task Import_WrongKind_Throws()
    {
        var store = this.MakeStore("wk-src");
        var planId = await CreateSamplePlanAsync(store);
        var exporter = this.MakeExporter(store);
        var outputPath = this.MakeOutput("wrong-kind.aioplan");
        await exporter.ExportAsync(planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        RewriteArchive(outputPath.Value, m => m.Replace("\"kind\":\"plan\"", "\"kind\":\"diagnose\""));

        Assert.Throws<InvalidDataException>(((Action)(() => PlanImporter.Load(outputPath))));
    }

    [Fact]
    public async Task Export_PlanNotFound_Throws()
    {
        var store = this.MakeStore("missing");
        var exporter = this.MakeExporter(store);
        var bogus = new PlanId(Guid.NewGuid());
        var outputPath = this.MakeOutput("missing.aioplan");

        var act = async () => await exporter.ExportAsync(
            bogus, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);
        await Assert.ThrowsAsync<InvalidOperationException>(act);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    private static readonly DateTimeOffset FixedTime = new(2025, 1, 15, 12, 0, 0, TimeSpan.Zero);

    private static string ReplacePlanId(string json) =>
        System.Text.RegularExpressions.Regex.Replace(json, "plan_[0-9a-fA-F]{32}", "plan_REDACTED");

    private AbsolutePath MakeOutput(string name) => new(Path.Combine(this.root, name));

    private PlanStore MakeStore(string sub = "default")
    {
        var dir = Path.Combine(this.root, "stores", sub);
        _ = Directory.CreateDirectory(dir);
        return new PlanStore(
            new AbsolutePath(dir),
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new NullEventBus(),
            new StaticOptions<PlanStoreOptions>(new PlanStoreOptions()),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<PlanStore>.Instance);
    }

    private PlanExporter MakeExporter(IPlanStore store) =>
        new(
            store,
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()));

    private PlanImporter MakeImporter(IPlanStore store) =>
        new(
            store,
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()));

    private static async Task<PlanId> CreateSamplePlanAsync(IPlanStore store)
    {
        var plan = new PlanModel
        {
            Name = "sample",
            Description = "A sample plan for tests.",
            Status = PlanStatus.Pending,
            Jobs = new Dictionary<string, JobNode>
            {
                ["j1"] = new JobNode { Id = "j1", Title = "Do a thing" },
            },
        };
        return await store.CreateAsync(plan, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
    }

    private static string ExtractText(string zipPath, string entryName)
    {
        using var archive = ZipFile.OpenRead(zipPath);
        var entry = archive.GetEntry(entryName) ?? throw new InvalidOperationException($"entry {entryName} missing");
        using var s = entry.Open();
        using var sr = new StreamReader(s, Encoding.UTF8);
        return sr.ReadToEnd();
    }

    private static void RewriteArchive(string zipPath, Func<string, string> manifestTransform)
    {
        // Load all entries into memory, transform the manifest, rewrite the archive from scratch.
        var entries = new List<(string Name, byte[] Bytes)>();
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in archive.Entries)
            {
                using var s = entry.Open();
                using var ms = new MemoryStream();
                s.CopyTo(ms);
                entries.Add((entry.FullName, ms.ToArray()));
            }
        }

        File.Delete(zipPath);
        using var fs = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None);
        using var zip = new ZipArchive(fs, ZipArchiveMode.Create, leaveOpen: false);
        foreach (var (name, bytes) in entries)
        {
            var data = name == "manifest.json"
                ? Encoding.UTF8.GetBytes(manifestTransform(Encoding.UTF8.GetString(bytes)))
                : bytes;
            var e = zip.CreateEntry(name, CompressionLevel.NoCompression);
            using var s = e.Open();
            s.Write(data, 0, data.Length);
        }
    }
}

internal sealed class StaticOptions<T> : IOptionsMonitor<T>
    where T : class
{
    private readonly T value;

    public StaticOptions(T value) => this.value = value;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable OnChange(Action<T, string?> listener) => new NoopDisposable();

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose()
        {
        }
    }
}

internal sealed class NullFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(false);

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(string.Empty);

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => default;

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => default;

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
}

internal sealed class NullEventBus : IEventBus
{
    public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
        where TEvent : notnull => default;

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => new NullDisposable();

    private sealed class NullDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => default;
    }
}
