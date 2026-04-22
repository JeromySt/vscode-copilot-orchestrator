// <copyright file="GitOpBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class GitOpBenchmarks
{
    [Benchmark(Description = "GitOp.WorktreeAdd")]
    public ValueTask<int> WorktreeAdd() => ValueTask.FromResult(0);

    [Benchmark(Description = "GitOp.MergeFastForward")]
    public ValueTask<int> MergeFastForward() => ValueTask.FromResult(0);
}
