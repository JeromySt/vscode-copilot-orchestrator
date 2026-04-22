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
    /// <summary>Setup phase: forward-integrate base into worktree, allocate lease.</summary>
    Setup = 0,

    /// <summary>Prechecks phase: run pre-conditions before agent work begins.</summary>
    Prechecks = 1,

    /// <summary>Work phase: invoke the agent runner.</summary>
    Work = 2,

    /// <summary>Postchecks phase: validate that work satisfies post-conditions.</summary>
    Postchecks = 3,

    /// <summary>Commit phase: stage and commit the changes (or assert no diff).</summary>
    Commit = 4,

    /// <summary>Forward integration phase: merge target onto worktree for downstream jobs.</summary>
    ForwardIntegration = 5,

    /// <summary>Done: terminal sentinel value indicating all phases completed.</summary>
    Done = 6,
}
