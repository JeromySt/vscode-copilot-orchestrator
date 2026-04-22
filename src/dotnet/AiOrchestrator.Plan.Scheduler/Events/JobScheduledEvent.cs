// <copyright file="JobScheduledEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Scheduler.Events;

/// <summary>Published when a job has been admitted and dispatched to the phase executor.</summary>
public sealed class JobScheduledEvent
{
    /// <summary>Gets the plan containing the job.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job that was scheduled for execution.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the UTC time when this event was published.</summary>
    public required DateTimeOffset At { get; init; }
}
