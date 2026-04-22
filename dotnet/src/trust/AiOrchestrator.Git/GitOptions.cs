// <copyright file="GitOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git;

/// <summary>Options controlling the <see cref="GitOperations"/> module.</summary>
public sealed record GitOptions
{
    /// <summary>
    /// Gets the interval at which long-running LG2 progress callbacks check the cancellation token.
    /// Cancellation must complete within <c>2 * ProgressTickInterval</c> (INV-2; default 200 ms).
    /// </summary>
    public TimeSpan ProgressTickInterval { get; init; } = TimeSpan.FromMilliseconds(100);

    /// <summary>Gets an explicit path to the <c>git</c> executable. Defaults to PATH lookup.</summary>
    public AbsolutePath? GitExecutable { get; init; }

    /// <summary>Gets a value indicating whether worktree operations should prefer the shell over LG2.</summary>
    public bool PreferShellForWorktree { get; init; } = true;
}
