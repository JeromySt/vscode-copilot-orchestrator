// <copyright file="LeaseAcquireTimeoutException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.WorktreeLease.Exceptions;

/// <summary>Thrown when <see cref="IWorktreeLease.AcquireAsync"/> exceeds <see cref="LeaseOptions.AcquireTimeout"/> (LS-CAS-2).</summary>
#pragma warning disable CA1032 // Implement standard exception constructors — required state is mandatory.
public sealed class LeaseAcquireTimeoutException : Exception
#pragma warning restore CA1032
{
    /// <summary>Initializes a new instance of the <see cref="LeaseAcquireTimeoutException"/> class.</summary>
    /// <param name="worktree">The worktree whose lease could not be acquired.</param>
    /// <param name="timeout">The timeout that elapsed.</param>
    public LeaseAcquireTimeoutException(AbsolutePath worktree, TimeSpan timeout)
        : base($"Could not acquire lease on '{worktree}' within {timeout}.")
    {
        this.Worktree = worktree;
        this.Timeout = timeout;
    }

    /// <summary>Gets the worktree path.</summary>
    public AbsolutePath Worktree { get; }

    /// <summary>Gets the timeout that elapsed.</summary>
    public TimeSpan Timeout { get; }
}
