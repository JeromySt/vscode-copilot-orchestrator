// <copyright file="PhaseFailureKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Classification of a phase failure consumed by <see cref="HealOrResumeStrategy"/>
/// to decide between phase-resume, auto-heal, or give-up (HEAL-RESUME-1).
/// </summary>
public enum PhaseFailureKind
{
    /// <summary>Network blip during a remote operation; eligible for blind retry.</summary>
    TransientNetwork = 0,

    /// <summary>OS-level file lock contention; eligible for blind retry.</summary>
    TransientFileLock = 1,

    /// <summary>Agent stopped because it exceeded its configured max-turns budget.</summary>
    AgentMaxTurnsExceeded = 2,

    /// <summary>Agent process exited with a non-zero status.</summary>
    AgentNonZeroExit = 3,

    /// <summary>Shell command exited with a non-zero status.</summary>
    ShellNonZeroExit = 4,

    /// <summary>Git merge produced unresolvable conflicts.</summary>
    MergeConflict = 5,

    /// <summary>Git remote rejected a push or fetch (non-recoverable).</summary>
    RemoteRejected = 6,

    /// <summary>Analyzer / test command surfaced a real failure to be auto-healed.</summary>
    AnalyzerOrTestFailure = 7,

    /// <summary>Phase exceeded its configured timeout.</summary>
    Timeout = 8,

    /// <summary>An internal invariant violation; never auto-healed.</summary>
    Internal = 9,

    /// <summary>Process crashed with OS-level fault code (NTSTATUS on Windows, signal on Unix).</summary>
    ProcessCrash = 10,
}
