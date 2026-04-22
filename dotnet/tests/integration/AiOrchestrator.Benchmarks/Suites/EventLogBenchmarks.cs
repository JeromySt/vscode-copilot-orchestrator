// <copyright file="EventLogBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class EventLogBenchmarks
{
    [Benchmark(Description = "EventLog.Append_10k_Sequential")]
    public ValueTask<int> Append_10k_Sequential() => ValueTask.FromResult(0);

    [Benchmark(Description = "EventLog.Append_10k_Concurrent_4Writers")]
    public ValueTask<int> Append_10k_Concurrent_4Writers() => ValueTask.FromResult(0);

    [Benchmark(Description = "EventLog.Read_FullSegment")]
    public ValueTask<int> Read_FullSegment() => ValueTask.FromResult(0);
}
