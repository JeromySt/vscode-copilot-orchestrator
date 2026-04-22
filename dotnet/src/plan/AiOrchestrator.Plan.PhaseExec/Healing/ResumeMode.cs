// <copyright file="ResumeMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>The category of recovery action to take after a phase failure (HEAL-RESUME-1).</summary>
public enum ResumeMode
{
    /// <summary>Resume the same phase without invoking the agent (transient retry).</summary>
    PhaseResume = 0,

    /// <summary>Re-run the work phase with auto-heal instructions.</summary>
    AutoHeal = 1,

    /// <summary>Stop attempting; record the failure and bail out.</summary>
    GiveUp = 2,
}
