// <copyright file="ResumeDecision.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>Decision returned by <see cref="HealOrResumeStrategy"/> after a phase failure.</summary>
public sealed record ResumeDecision
{
    /// <summary>Gets the chosen recovery mode.</summary>
    public required ResumeMode Mode { get; init; }

    /// <summary>Gets the phase the executor should resume from when <see cref="Mode"/> is not <see cref="ResumeMode.GiveUp"/>.</summary>
    public required JobPhase ResumeFromPhase { get; init; }

    /// <summary>Gets a human-readable rationale explaining the decision (used in logs and audit records).</summary>
    public required string Reason { get; init; }
}
