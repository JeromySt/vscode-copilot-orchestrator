// <copyright file="LeaseInfo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.WorktreeLease;

/// <summary>Read-only snapshot of a worktree lease returned by <see cref="IWorktreeLease.InspectAsync"/>.</summary>
public sealed record LeaseInfo
{
    /// <summary>Gets the fencing token of the current lease.</summary>
    public required FencingToken Token { get; init; }

    /// <summary>Gets the principal that currently holds the lease.</summary>
    public required AuthContext Holder { get; init; }

    /// <summary>Gets the UTC time at which the lease expires if not renewed.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets the UTC time at which the lease was acquired (or last renewed).</summary>
    public required DateTimeOffset AcquiredAt { get; init; }
}
