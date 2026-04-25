// <copyright file="PortabilityCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Portability;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Portability.Tests;

/// <summary>Coverage gap tests for exception types and importer/exporter edge cases.</summary>
public sealed class PortabilityCoverageGapTests : IDisposable
{
    private readonly string root;

    public PortabilityCoverageGapTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "port-gap-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(this.root)) Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    // ── ImportConflictException ──

    [Fact]
    public void ImportConflictException_DefaultCtor_HasMessage()
    {
        var ex = new ImportConflictException
        {
            ExistingPlanId = new PlanId(Guid.NewGuid()),
            ExistingStatus = PlanStatus.Pending,
        };
        Assert.NotNull(ex.Message);
        Assert.Contains("conflict", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ImportConflictException_MessageCtor()
    {
        var ex = new ImportConflictException("custom msg")
        {
            ExistingPlanId = new PlanId(Guid.NewGuid()),
            ExistingStatus = PlanStatus.Running,
        };
        Assert.Equal("custom msg", ex.Message);
        Assert.Equal(PlanStatus.Running, ex.ExistingStatus);
    }

    [Fact]
    public void ImportConflictException_MessageAndInnerCtor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new ImportConflictException("outer", inner)
        {
            ExistingPlanId = new PlanId(Guid.NewGuid()),
            ExistingStatus = PlanStatus.Archived,
        };
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
        Assert.Equal(PlanStatus.Archived, ex.ExistingStatus);
    }

    [Fact]
    public void ImportConflictException_ExposesProperties()
    {
        var planId = new PlanId(Guid.NewGuid());
        var ex = new ImportConflictException("msg")
        {
            ExistingPlanId = planId,
            ExistingStatus = PlanStatus.Succeeded,
        };
        Assert.Equal(planId, ex.ExistingPlanId);
        Assert.Equal(PlanStatus.Succeeded, ex.ExistingStatus);
    }

    // ── PortabilitySchemaMismatchException ──

    [Fact]
    public void SchemaMismatchException_DefaultCtor_HasMessage()
    {
        var ex = new PortabilitySchemaMismatchException
        {
            Expected = new Version(1, 0),
            Actual = new Version(2, 0),
        };
        Assert.NotNull(ex.Message);
    }

    [Fact]
    public void SchemaMismatchException_MessageCtor()
    {
        var ex = new PortabilitySchemaMismatchException("custom")
        {
            Expected = new Version(1, 0),
            Actual = new Version(3, 0),
        };
        Assert.Equal("custom", ex.Message);
        Assert.Equal(new Version(1, 0), ex.Expected);
        Assert.Equal(new Version(3, 0), ex.Actual);
    }

    [Fact]
    public void SchemaMismatchException_MessageAndInnerCtor()
    {
        var inner = new Exception("inner");
        var ex = new PortabilitySchemaMismatchException("outer", inner)
        {
            Expected = new Version(1, 0),
            Actual = new Version(2, 0),
        };
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    // ── PlanImporter edge cases ──

    [Fact]
    public void Import_MissingPlanJson_Throws()
    {
        var p = MakeOutput("no-plan.aioplan");
        using (var fs = new FileStream(p.Value, FileMode.Create))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            var e = zip.CreateEntry("manifest.json");
            using var w = new StreamWriter(e.Open());
            w.Write("{\"schemaVersion\":\"1.0\",\"createdAt\":\"2025-01-01T00:00:00Z\",\"kind\":\"plan\"}");
        }

        Assert.Throws<InvalidDataException>(() => PlanImporter.Load(p));
    }

    [Fact]
    public void LoadArchive_MissingSchemaVersion_Throws()
    {
        var p = MakeOutput("no-schema.aioplan");
        using (var fs = new FileStream(p.Value, FileMode.Create))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            var m = zip.CreateEntry("manifest.json");
            using (var w = new StreamWriter(m.Open())) { w.Write("{\"createdAt\":\"2025-01-01T00:00:00Z\"}"); }
            var plan = zip.CreateEntry("plan.json");
            using (var w = new StreamWriter(plan.Open())) { w.Write("{}"); }
        }

        Assert.ThrowsAny<Exception>(() => PlanImporter.Load(p));
    }

    [Fact]
    public async Task Import_PathValidation_RejectsTraversal()
    {
        // Create a valid archive first
        var store = MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var exporter = MakeExporter(store);
        var archivePath = MakeOutput("traversal.aioplan");
        await exporter.ExportAsync(planId, archivePath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);

        // Importer with a path validator that rejects everything
        var importer = new PlanImporter(
            MakeStore("dest"),
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()),
            new RejectAllPathValidator());

        var act = async () => await importer.ImportAsync(archivePath, new ImportOptions(), CancellationToken.None);
        await Assert.ThrowsAnyAsync<Exception>(act);
    }

    [Fact]
    public async Task Export_PathValidation_RejectsTraversal()
    {
        var store = MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var outputPath = MakeOutput("export-reject.aioplan");

        var exporter = new PlanExporter(
            store,
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()),
            new RejectAllPathValidator());

        var act = async () => await exporter.ExportAsync(
            planId, outputPath, new ExportOptions { OverrideCreatedAt = FixedTime }, CancellationToken.None);
        await Assert.ThrowsAnyAsync<Exception>(act);
    }

    [Fact]
    public async Task Import_NullOptions_Throws()
    {
        var store = MakeStore();
        var importer = MakeImporter(store);
        var archivePath = MakeOutput("null-opts.aioplan");

        var act = async () => await importer.ImportAsync(archivePath, null!, CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    [Fact]
    public async Task Export_NullOptions_Throws()
    {
        var store = MakeStore();
        var planId = await CreateSamplePlanAsync(store);
        var exporter = MakeExporter(store);
        var outputPath = MakeOutput("null-export-opts.aioplan");

        var act = async () => await exporter.ExportAsync(planId, outputPath, null!, CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    [Fact]
    public void LoadArchive_ExtraEntries_IncludedInArtifacts()
    {
        var p = MakeOutput("extras.aioplan");
        using (var fs = new FileStream(p.Value, FileMode.Create))
        using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
        {
            var manifest = zip.CreateEntry("manifest.json");
            using (var w = new StreamWriter(manifest.Open()))
            {
                w.Write("{\"schemaVersion\":\"1.0\",\"createdAt\":\"2025-01-01T00:00:00Z\",\"kind\":\"plan\"}");
            }

            var plan = zip.CreateEntry("plan.json");
            using (var w = new StreamWriter(plan.Open()))
            {
                w.Write("{\"name\":\"test\",\"status\":\"Pending\",\"jobs\":{}}");
            }

            var extra = zip.CreateEntry("extra/readme.txt");
            using (var w = new StreamWriter(extra.Open()))
            {
                w.Write("hello");
            }
        }

        var archive = PlanImporter.Load(p);
        Assert.True(archive.Artifacts.ContainsKey("extra/readme.txt"));
        Assert.Equal("hello", Encoding.UTF8.GetString(archive.Artifacts["extra/readme.txt"]));
    }

    // ── helpers ──

    private static readonly DateTimeOffset FixedTime = new(2025, 1, 15, 12, 0, 0, TimeSpan.Zero);

    private AbsolutePath MakeOutput(string name) => new(Path.Combine(this.root, name));

    private PlanStore MakeStore(string sub = "default")
    {
        var dir = Path.Combine(this.root, "stores", sub);
        Directory.CreateDirectory(dir);
        return new PlanStore(
            new AbsolutePath(dir),
            new NullFileSystem(),
            new InMemoryClock(FixedTime),
            new NullEventBus(),
            new StaticOptions<PlanStoreOptions>(new PlanStoreOptions()),
            NullLogger<PlanStore>.Instance);
    }

    private PlanExporter MakeExporter(IPlanStore store) =>
        new(store, new NullFileSystem(), new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()));

    private PlanImporter MakeImporter(IPlanStore store) =>
        new(store, new NullFileSystem(), new InMemoryClock(FixedTime),
            new StaticOptions<PortabilityOptions>(new PortabilityOptions()));

    private static async Task<PlanId> CreateSamplePlanAsync(IPlanStore store)
    {
        var plan = new PlanModel
        {
            Name = "sample",
            Status = PlanStatus.Pending,
            Jobs = new System.Collections.Generic.Dictionary<string, JobNode>
            {
                ["j1"] = new JobNode { Id = "j1", Title = "Do a thing" },
            },
        };
        return await store.CreateAsync(plan, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
    }

    private sealed class RejectAllPathValidator : IPathValidator
    {
        public void AssertSafe(AbsolutePath candidate, AbsolutePath allowedRoot)
            => throw new InvalidOperationException("Path validation rejected.");

        public ValueTask<Stream> OpenReadUnderRootAsync(AbsolutePath allowedRoot, AiOrchestrator.Models.Paths.RelativePath relative, CancellationToken ct)
            => throw new InvalidOperationException("Path validation rejected.");
    }
}
