// <copyright file="JobPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Per-job execution phase, ordered exactly as it appears in the phase pipeline (§3.12.6).
/// Numeric ordering matches execution order so callers may compare phases directly.
/// </summary>
public enum JobPhase
{
    /// <summary>Merge-FI phase: merge base branch into worktree before setup.</summary>
    MergeForwardIntegration = 0,

    /// <summary>Setup phase: allocate lease, prepare worktree.</summary>
    Setup = 1,

    /// <summary>Prechecks phase: run pre-conditions before agent work begins.</summary>
    Prechecks = 2,

    /// <summary>Work phase: invoke the agent runner.</summary>
    Work = 3,

    /// <summary>Commit phase: stage and commit the changes (or assert no diff).</summary>
    Commit = 4,

    /// <summary>Postchecks phase: validate that work satisfies post-conditions.</summary>
    Postchecks = 5,

    /// <summary>Merge-RI phase: merges the target branch onto the worktree so downstream jobs see this job's changes.</summary>
    MergeReverseIntegration = 6,

    /// <summary>Done: terminal sentinel value indicating all phases completed.</summary>
    Done = 7,
}
