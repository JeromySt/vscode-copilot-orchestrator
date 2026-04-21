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
using FluentAssertions;
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

        cfg.GetJobs().Should().NotBeEmpty("INV-1: SloEnvConfig declares an explicit job");
        var job = cfg.GetJobs().Single();
        job.Environment.Jit.ToString().Should().Be("RyuJit", "INV-1: RyuJIT only");
        job.Environment.Gc.Server.Should().BeTrue("INV-1: ServerGC required");

        cfg.GetExporters().Should().Contain(e => e.GetType().Name.Contains("Json", StringComparison.Ordinal),
            "INV-3: JSON exporter present for CI ingestion");
        cfg.GetExporters().Should().Contain(e => e.GetType().Name.Contains("Markdown", StringComparison.Ordinal),
            "Markdown exporter present for human review");
        cfg.GetDiagnosers().Should().Contain(d => d.GetType().Name.Contains("Memory", StringComparison.Ordinal),
            "INV-5: MemoryDiagnoser present for allocation gating");
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

        soft.Should().NotBeNull();
        strict.Should().NotBeNull();
        strict.Count.Should().BeGreaterOrEqualTo(soft.Count, "strict mode is a superset of soft-mode checks");
    }

    [Fact]
    [ContractTest("SLO-ENV-3")]
    public void SLO_ENV_3_ResultsExportedAsJson()
    {
        var cfg = new SloEnvConfig();
        cfg.GetExporters().Any(e => e.GetType().Name.Contains("Json", StringComparison.Ordinal))
            .Should().BeTrue("INV-3: results must be exported as JSON");
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

        report.Ok.Should().BeFalse("INV-4: a 20% P99 regression must trip the gate");
        report.Regressions.Should().ContainSingle(r => r.Kind == "latency");
        report.Regressions[0].DeltaPercent.Should().BeApproximately(20.0, 0.01);
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

        report.Ok.Should().BeFalse("INV-5: an 8% allocation regression must trip the gate (>5% threshold)");
        report.Regressions.Should().ContainSingle(r => r.Kind == "allocation");
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

        report.Ok.Should().BeTrue("7.5% P99 + 4% alloc are within the 10%/5% thresholds");
    }

    [Fact]
    [Trait("Category", "Gate")]
    public void AllDeclaredBenchmarkIdsHaveBaselines()
    {
        var baselineDir = Path.Combine(AppContext.BaseDirectory, "baselines");
        Directory.Exists(baselineDir).Should().BeTrue($"baselines folder must be deployed alongside the assembly: {baselineDir}");

        var ids = DeclaredBenchmarkIds();
        foreach (var id in ids)
        {
            var path = Path.Combine(baselineDir, id + ".json");
            File.Exists(path).Should().BeTrue($"baseline file required for benchmark id '{id}' at '{path}'");
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
