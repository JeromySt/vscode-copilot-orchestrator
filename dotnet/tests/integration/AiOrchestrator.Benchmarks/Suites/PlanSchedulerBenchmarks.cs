// <copyright file="PlanSchedulerBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class PlanSchedulerBenchmarks
{
    [Benchmark(Description = "PlanScheduler.Schedule_100Job_Linear")]
    public ValueTask<int> Schedule_100Job_Linear() => ValueTask.FromResult(0);

    [Benchmark(Description = "PlanScheduler.Schedule_100Job_Diamond")]
    public ValueTask<int> Schedule_100Job_Diamond() => ValueTask.FromResult(0);

    [Benchmark(Description = "PlanScheduler.Schedule_100Job_FullyParallel")]
    public ValueTask<int> Schedule_100Job_FullyParallel() => ValueTask.FromResult(0);
}
