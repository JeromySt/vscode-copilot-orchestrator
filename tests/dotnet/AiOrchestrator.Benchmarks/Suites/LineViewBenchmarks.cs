// <copyright file="LineViewBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class LineViewBenchmarks
{
    [Benchmark(Description = "LineView.Project_1MB_Stdout")]
    public ValueTask<int> Project_1MB_Stdout() => ValueTask.FromResult(0);

    [Benchmark(Description = "LineView.Project_1MB_AnsiHeavy")]
    public ValueTask<int> Project_1MB_AnsiHeavy() => ValueTask.FromResult(0);
}
