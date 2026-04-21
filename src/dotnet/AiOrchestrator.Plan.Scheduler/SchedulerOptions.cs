// <copyright file="SchedulerOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.ComponentModel.DataAnnotations;

namespace AiOrchestrator.Plan.Scheduler;

/// <summary>Configuration options for the plan scheduler.</summary>
public sealed record SchedulerOptions
{
    /// <summary>Gets the maximum number of jobs that may run concurrently across all plans.</summary>
    [Range(1, 1024)]
    public int GlobalMaxParallel { get; init; } = 16;

    /// <summary>Gets the bounded capacity of the ready-job channel (CONC-CHAN-1).</summary>
    [Range(16, 100_000)]
    public int ReadyChannelCapacity { get; init; } = 1024;

    /// <summary>Gets the bounded capacity of the scheduled-job channel (CONC-CHAN-1).</summary>
    [Range(16, 100_000)]
    public int ScheduledChannelCapacity { get; init; } = 256;

    /// <summary>Gets the time window within which duplicate schedule events are suppressed (CONC-CHAN-2).</summary>
    public TimeSpan DedupWindow { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Gets a value indicating whether event deduplication is enabled (CONC-CHAN-2).</summary>
    public bool EnableEventDedup { get; init; } = true;
}
