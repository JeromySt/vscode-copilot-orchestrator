// <copyright file="JobStatusChangedEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Store.Events;

/// <summary>
/// Published to the event bus whenever a job's status changes.
/// This is the primary event UX interfaces subscribe to for real-time job progress.
/// </summary>
public sealed record JobStatusChangedEvent
{
    /// <summary>Gets the plan containing the job.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job whose status changed.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the status before the transition.</summary>
    public required JobStatus PreviousStatus { get; init; }

    /// <summary>Gets the status after the transition.</summary>
    public required JobStatus NewStatus { get; init; }

    /// <summary>Gets the UTC time when this event was published.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets an optional reason for the transition (e.g. which predecessor caused a block).</summary>
    public string? Reason { get; init; }
}
