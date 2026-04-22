// <copyright file="SloEnvConfig.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using BenchmarkDotNet.Columns;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Diagnosers;
using BenchmarkDotNet.Engines;
using BenchmarkDotNet.Environments;
using BenchmarkDotNet.Exporters;
using BenchmarkDotNet.Exporters.Json;
using BenchmarkDotNet.Jobs;
using BenchmarkDotNet.Loggers;
using BenchmarkDotNet.Reports;
using BenchmarkDotNet.Validators;

namespace AiOrchestrator.Benchmarks;

/// <summary>SLO-ENV-1: Documents and (where possible) enforces the benchmark environment.</summary>
/// <remarks>
/// <para>Adds Job_Net10_RyuJIT_ServerGC, environmental validators, MarkdownExporter,
/// JsonExporter, RankColumn, and MemoryDiagnoser.</para>
/// </remarks>
internal sealed class SloEnvConfig : ManualConfig
{
    /// <summary>Initializes a new instance of the <see cref="SloEnvConfig"/> class.</summary>
    public SloEnvConfig()
    {
        var job = Job.Default
            .WithJit(Jit.RyuJit)
            .WithGcServer(true)
            .WithGcConcurrent(true)
            .WithStrategy(RunStrategy.Throughput)
            .WithId("Net10_RyuJIT_ServerGC");

        this.AddJob(job);
        this.AddDiagnoser(MemoryDiagnoser.Default);
        this.AddColumnProvider(DefaultColumnProviders.Instance);
        this.AddColumn(RankColumn.Stars);
        this.AddColumn(StatisticColumn.P50);
        this.AddColumn(StatisticColumn.P95);
        this.AddColumn(StatisticColumn.AllStatistics);
        this.AddExporter(MarkdownExporter.GitHub);
        this.AddExporter(JsonExporter.FullCompressed);
        this.AddLogger(ConsoleLogger.Default);
        this.AddValidator(JitOptimizationsValidator.FailOnError);
        this.AddValidator(BaselineValidator.FailOnError);
        this.WithSummaryStyle(SummaryStyle.Default);
        this.WithOption(ConfigOptions.DisableLogFile, false);
    }
}
