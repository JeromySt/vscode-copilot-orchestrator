// <copyright file="WorktreeLockedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when an operation cannot proceed because a worktree is locked.</summary>
public sealed class WorktreeLockedException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="WorktreeLockedException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public WorktreeLockedException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the path of the locked worktree.</summary>
    public required AbsolutePath WorktreePath { get; init; }

    /// <summary>Gets the lock reason recorded by git.</summary>
    public required string LockReason { get; init; }
}
