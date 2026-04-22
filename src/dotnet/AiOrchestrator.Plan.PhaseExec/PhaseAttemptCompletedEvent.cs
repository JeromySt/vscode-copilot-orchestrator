// <copyright file="PhaseAttemptCompletedEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>Published after each phase-attempt completes (success or failure).</summary>
public sealed record PhaseAttemptCompletedEvent
{
    /// <summary>Gets the plan owning the job.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job whose attempt completed.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets when the event was published.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets the recorded attempt details.</summary>
    public required JobAttempt Attempt { get; init; }
}
