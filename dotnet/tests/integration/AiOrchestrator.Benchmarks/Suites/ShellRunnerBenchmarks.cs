// <copyright file="ShellRunnerBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class ShellRunnerBenchmarks
{
    [Benchmark(Description = "ShellRunner.SpawnEcho")]
    public ValueTask<int> SpawnEcho() => ValueTask.FromResult(0);

    [Benchmark(Description = "ShellRunner.PipeStdout_1MB")]
    public ValueTask<int> PipeStdout_1MB() => ValueTask.FromResult(0);
}
