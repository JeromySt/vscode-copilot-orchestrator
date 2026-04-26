// <copyright file="ProcessTreeNode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Process;

/// <summary>Stats for a single process in the tree.</summary>
public sealed record ProcessStats
{
    /// <summary>Gets the operating-system process identifier.</summary>
    public required int Pid { get; init; }

    /// <summary>Gets the parent process identifier.</summary>
    public int ParentPid { get; init; }

    /// <summary>Gets the process name.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the full command line, if available.</summary>
    public string? CommandLine { get; init; }

    /// <summary>Gets the approximate CPU usage percentage (0–100).</summary>
    public double CpuPercent { get; init; }

    /// <summary>Gets the working set memory in bytes.</summary>
    public long MemoryBytes { get; init; }

    /// <summary>Gets the number of threads in the process.</summary>
    public int ThreadCount { get; init; }
}

/// <summary>A process node with optional children forming a tree.</summary>
public sealed record ProcessTreeNode
{
    /// <summary>Gets the stats for this process.</summary>
    public required ProcessStats Stats { get; init; }

    /// <summary>Gets the child process nodes.</summary>
    public IReadOnlyList<ProcessTreeNode> Children { get; init; } = Array.Empty<ProcessTreeNode>();
}
