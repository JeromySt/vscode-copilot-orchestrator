// <copyright file="CommitInputs.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.HookGate;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>Inputs needed by the Commit phase.</summary>
public sealed record CommitInputs
{
    /// <summary>Gets the absolute path to the worktree to commit in.</summary>
    public required AbsolutePath Repo { get; init; }

    /// <summary>Gets the commit message.</summary>
    public required string Message { get; init; }

    /// <summary>Gets the principal whose identity is used as the git author.</summary>
    public required AuthContext Author { get; init; }

    /// <summary>Gets the hook-gate check-in request to issue before <c>git commit</c> (INV-9).</summary>
    public required HookCheckInRequest HookCheckInRequest { get; init; }

    /// <summary>
    /// Gets a value indicating whether this job is expected to produce no diff (INV-10).
    /// When <see langword="true"/> the commit succeeds iff the worktree is clean; otherwise it fails.
    /// </summary>
    public bool ExpectsNoChanges { get; init; }

    /// <summary>Gets the estimated number of bytes the commit will occupy on disk; ≤ 0 means "use default".</summary>
    public long EstimatedBytes { get; init; }
}
