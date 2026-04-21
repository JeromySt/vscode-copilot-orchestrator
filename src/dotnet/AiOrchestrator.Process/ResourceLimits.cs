// <copyright file="ResourceLimits.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Process;

/// <summary>
/// Describes operating-system resource constraints to apply to a spawned child process.
/// On Linux these are enforced via <c>setrlimit(2)</c> and cgroups v2;
/// on Windows via Job Objects.
/// </summary>
public sealed record ResourceLimits
{
    /// <summary>Gets the maximum virtual memory address space size in bytes, or <see langword="null"/> for no limit.</summary>
    public long? MaxMemoryBytes { get; init; }

    /// <summary>Gets the maximum accumulated CPU time, or <see langword="null"/> for no limit.</summary>
    public TimeSpan? MaxCpuTime { get; init; }

    /// <summary>Gets the maximum number of simultaneously open file descriptors, or <see langword="null"/> for no limit.</summary>
    public int? MaxOpenFiles { get; init; }

    /// <summary>Gets the maximum number of child processes, or <see langword="null"/> for no limit.</summary>
    public int? MaxProcesses { get; init; }
}
