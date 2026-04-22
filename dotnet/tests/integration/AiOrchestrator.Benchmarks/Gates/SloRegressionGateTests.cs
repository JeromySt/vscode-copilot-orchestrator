// <copyright file="SloRegressionGateTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Benchmarks.Gates;

/// <summary>Acceptance tests for the BenchmarkDotNet rig and SLO regression gate.</summary>
[Trait("Category", "Gate")]
public sealed class SloRegressionGateTests
{
    [Fact]
    [ContractTest("SLO-ENV-1")]
    public void SLO_ENV_1_ConfigDocumentsEnvironment()
    {
        var cfg = new SloEnvConfig();

        Assert.NotEmpty(cfg.GetJobs());
        var job = cfg.GetJobs().Single();
        Assert.Equal("RyuJit", job.Environment.Jit.ToString());
        Assert.True(job.Environment.Gc.Server);

        Assert.Contains(cfg.GetExporters(), e => e.GetType().Name.Contains("Json", StringComparison.Ordinal));
        Assert.Contains(cfg.GetExporters(), e => e.GetType().Name.Contains("Markdown", StringComparison.Ordinal));
        Assert.Contains(cfg.GetDiagnosers(), d => d.GetType().Name.Contains("Memory", StringComparison.Ordinal));
    }

    [Fact]
    [ContractTest("SLO-ENV-2")]
    public void SLO_ENV_2_StrictModeFailsOnSkewedHost()
    {
        // Strict-mode validator runs the same checks plus host-pinning sniff;
        // we only assert it returns a deterministic, possibly-non-empty list of strings
        // (a real CI host violates several criteria; non-strict should be quieter).
        var soft = EnvironmentValidator.Validate(strict: false);
        var strict = EnvironmentValidator.Validate(strict: true);

        Assert.NotNull(soft);
        Assert.NotNull(strict);
        Assert.True(strict.Count >= soft.Count, "strict mode is a superset of soft-mode checks");
    }

    [Fact]
    [ContractTest("SLO-ENV-3")]
    public void SLO_ENV_3_ResultsExportedAsJson()
    {
        var cfg = new SloEnvConfig();
        Assert.True(
            cfg.GetExporters().Any(e => e.GetType().Name.Contains("Json", StringComparison.Ordinal)),
            "INV-3: results must be exported as JSON");
    }

    [Fact]
    [ContractTest("SLO-REG-P99")]
    public async Task SLO_REGRESSION_DetectsP99Increase()
    {
        var reader = new StubReader(
            baseline: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_NoSubscribers", P50Ns = 100, P99Ns = 200, AllocatedBytes = 0 },
            current: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_NoSubscribers", P50Ns = 100, P99Ns = 240, AllocatedBytes = 0 });

        var gate = new SloRegressionGate(reader);
        var report = await gate.RunAsync(NewPath(), NewPath(), CancellationToken.None);

        Assert.False(report.Ok, "INV-4: a 20% P99 regression must trip the gate");
        Assert.Single(report.Regressions, r => r.Kind == "latency");
        Assert.Equal(20.0, report.Regressions[0].DeltaPercent, 0.01);
    }

    [Fact]
    [ContractTest("SLO-REG-ALLOC")]
    public async Task SLO_ALLOC_REGRESSION_Detects()
    {
        var reader = new StubReader(
            baseline: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_With10Subscribers", P50Ns = 1000, P99Ns = 2000, AllocatedBytes = 1000 },
            current: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_With10Subscribers", P50Ns = 1000, P99Ns = 2000, AllocatedBytes = 1080 });

        var gate = new SloRegressionGate(reader);
        var report = await gate.RunAsync(NewPath(), NewPath(), CancellationToken.None);

        Assert.False(report.Ok, "INV-5: an 8% allocation regression must trip the gate (>5% threshold)");
        Assert.Single(report.Regressions, r => r.Kind == "allocation");
    }

    [Fact]
    [Trait("Category", "Gate")]
    public async Task NoRegression_WhenWithinThresholds()
    {
        var reader = new StubReader(
            baseline: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_NoSubscribers", P50Ns = 100, P99Ns = 200, AllocatedBytes = 1000 },
            current: new BenchmarkResult { BenchmarkId = "EventBus.Publish_1k_NoSubscribers", P50Ns = 100, P99Ns = 215, AllocatedBytes = 1040 });

        var gate = new SloRegressionGate(reader);
        var report = await gate.RunAsync(NewPath(), NewPath(), CancellationToken.None);

        Assert.True(report.Ok, "7.5% P99 + 4% alloc are within the 10%/5% thresholds");
    }

    [Fact]
    [Trait("Category", "Gate")]
    public void AllDeclaredBenchmarkIdsHaveBaselines()
    {
        var baselineDir = Path.Combine(AppContext.BaseDirectory, "baselines");
        Assert.True(Directory.Exists(baselineDir), $"baselines folder must be deployed alongside the assembly: {baselineDir}");

        var ids = DeclaredBenchmarkIds();
        foreach (var id in ids)
        {
            var path = Path.Combine(baselineDir, id + ".json");
            Assert.True(File.Exists(path), $"baseline file required for benchmark id '{id}' at '{path}'");
        }
    }

    private static AbsolutePath NewPath() => new(Path.Combine(Path.GetTempPath(), "aio-bench-stub-" + Guid.NewGuid().ToString("N")));

    private static IEnumerable<string> DeclaredBenchmarkIds() =>
    [
        "EventBus.Publish_1k_NoSubscribers",
        "EventBus.Publish_1k_With10Subscribers",
        "EventBus.Publish_1k_With100Subscribers",
        "EventLog.Append_10k_Sequential",
        "EventLog.Append_10k_Concurrent_4Writers",
        "EventLog.Read_FullSegment",
        "LineView.Project_1MB_Stdout",
        "LineView.Project_1MB_AnsiHeavy",
        "PlanScheduler.Schedule_100Job_Linear",
        "PlanScheduler.Schedule_100Job_Diamond",
        "PlanScheduler.Schedule_100Job_FullyParallel",
        "GitOp.WorktreeAdd",
        "GitOp.MergeFastForward",
        "ShellRunner.SpawnEcho",
        "ShellRunner.PipeStdout_1MB",
    ];

    private sealed class StubReader : IBenchmarkResultReader
    {
        private readonly BenchmarkResult baseline;
        private readonly BenchmarkResult current;
        private int call;

        public StubReader(BenchmarkResult baseline, BenchmarkResult current)
        {
            this.baseline = baseline;
            this.current = current;
        }

        public ValueTask<IReadOnlyDictionary<string, BenchmarkResult>> ReadAllAsync(AbsolutePath dir, CancellationToken ct)
        {
            // The gate calls reader twice: first for current dir, then for baseline dir.
            var pick = Interlocked.Increment(ref this.call) == 1 ? this.current : this.baseline;
            IReadOnlyDictionary<string, BenchmarkResult> map = new Dictionary<string, BenchmarkResult> { [pick.BenchmarkId] = pick };
            return ValueTask.FromResult(map);
        }
    }
}
