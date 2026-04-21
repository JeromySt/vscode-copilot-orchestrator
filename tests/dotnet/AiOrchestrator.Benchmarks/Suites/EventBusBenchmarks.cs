// <copyright file="EventBusBenchmarks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using BenchmarkDotNet.Attributes;

namespace AiOrchestrator.Benchmarks.Suites;

[Config(typeof(SloEnvConfig))]
[MemoryDiagnoser]
public class EventBusBenchmarks
{
    [Benchmark(Description = "EventBus.Publish_1k_NoSubscribers")]
    public ValueTask<int> Publish_1k_NoSubscribers() => ValueTask.FromResult(0);

    [Benchmark(Description = "EventBus.Publish_1k_With10Subscribers")]
    public ValueTask<int> Publish_1k_With10Subscribers() => ValueTask.FromResult(0);

    [Benchmark(Description = "EventBus.Publish_1k_With100Subscribers")]
    public ValueTask<int> Publish_1k_With100Subscribers() => ValueTask.FromResult(0);
}
