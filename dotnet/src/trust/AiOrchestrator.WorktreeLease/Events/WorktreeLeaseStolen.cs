// <copyright file="WorktreeLeaseStolen.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.WorktreeLease.Events;

/// <summary>
/// Event published on the bus by <see cref="Detection.StaleLeaseDetector"/> when the
/// on-disk lease token diverges from the token the holder expects (INV-6).
/// </summary>
public sealed class WorktreeLeaseStolen
{
    /// <summary>Gets the worktree whose lease was stolen.</summary>
    public required AbsolutePath Worktree { get; init; }

    /// <summary>Gets the token the local holder believed it held.</summary>
    public required FencingToken ExpectedToken { get; init; }

    /// <summary>Gets the token currently observed in the lease file.</summary>
    public required FencingToken ObservedToken { get; init; }

    /// <summary>Gets the UTC time at which the divergence was observed.</summary>
    public required DateTimeOffset At { get; init; }
}
