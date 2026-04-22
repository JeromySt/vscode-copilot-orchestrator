// <copyright file="SloTarget.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Benchmarks;

/// <summary>Documented service-level objective for a single benchmark.</summary>
public sealed record SloTarget
{
    /// <summary>Gets the canonical benchmark identifier (e.g. "EventBus.Publish_1k_NoSubscribers").</summary>
    public required string BenchmarkId { get; init; }

    /// <summary>Gets the median (P50) latency target.</summary>
    public required TimeSpan P50 { get; init; }

    /// <summary>Gets the 99th percentile latency target.</summary>
    public required TimeSpan P99 { get; init; }

    /// <summary>Gets the maximum allocated bytes per operation, or null if not gated.</summary>
    public required long? MaxAllocatedBytes { get; init; }
}
