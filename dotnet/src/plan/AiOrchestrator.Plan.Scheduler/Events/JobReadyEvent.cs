// <copyright file="JobReadyEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Scheduler.Events;

/// <summary>Published when a job transitions to the ready state (all predecessors succeeded).</summary>
public sealed class JobReadyEvent
{
    /// <summary>Gets the plan containing the job.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job that became ready.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the identifiers of the job's predecessors that all succeeded.</summary>
    public required ImmutableArray<JobId> Predecessors { get; init; }

    /// <summary>Gets the UTC time when this event was published.</summary>
    public required DateTimeOffset At { get; init; }
}
