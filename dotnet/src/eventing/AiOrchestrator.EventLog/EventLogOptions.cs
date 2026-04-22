// <copyright file="EventLogOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.EventLog;

/// <summary>Configurable options governing the tiered event log.</summary>
public sealed record EventLogOptions
{
    /// <summary>Gets the maximum bytes the T2 reassembly buffer may hold before abandoning a partial record (T2-READ-11).</summary>
    public int ReassemblyMaxBytes { get; init; } = 16 * 1024 * 1024;

    /// <summary>Gets the wall-clock budget for completing a partial T2 record before abandoning (T2-READ-11).</summary>
    public TimeSpan ReassemblyTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Gets the per-plan T2 disk byte cap (DISK-PLAN-1).</summary>
    public long PerPlanDiskCapBytes { get; init; } = 1024L * 1024L * 1024L;

    /// <summary>Gets the age at which T2 segments are eligible for T3 cold compression.</summary>
    public TimeSpan ColdArchiveAge { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>Gets the number of envelopes retained in the in-memory T1 hot ring buffer.</summary>
    public int HotRingCapacity { get; init; } = 4096;
}
