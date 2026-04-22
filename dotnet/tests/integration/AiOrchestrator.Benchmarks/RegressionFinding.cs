// <copyright file="RegressionFinding.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Benchmarks;

/// <summary>A single detected regression (latency or allocation).</summary>
public sealed record RegressionFinding
{
    /// <summary>Gets the benchmark identifier.</summary>
    public required string BenchmarkId { get; init; }

    /// <summary>Gets the baseline P99 latency.</summary>
    public required TimeSpan BaselineP99 { get; init; }

    /// <summary>Gets the current run's P99 latency.</summary>
    public required TimeSpan CurrentP99 { get; init; }

    /// <summary>Gets the percentage delta (positive == regression).</summary>
    public required double DeltaPercent { get; init; }

    /// <summary>Gets the kind of regression ("latency" or "allocation").</summary>
    public string Kind { get; init; } = "latency";

    /// <summary>Gets the baseline allocated bytes (zero when not applicable).</summary>
    public long BaselineAllocatedBytes { get; init; }

    /// <summary>Gets the current allocated bytes (zero when not applicable).</summary>
    public long CurrentAllocatedBytes { get; init; }
}
