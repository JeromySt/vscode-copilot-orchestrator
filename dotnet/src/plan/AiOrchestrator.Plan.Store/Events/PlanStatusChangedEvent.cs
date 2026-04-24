// <copyright file="PlanStatusChangedEvent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Store.Events;

/// <summary>
/// Published to the event bus whenever a plan's status changes.
/// </summary>
public sealed record PlanStatusChangedEvent
{
    /// <summary>Gets the plan whose status changed.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the status before the transition.</summary>
    public required PlanStatus PreviousStatus { get; init; }

    /// <summary>Gets the status after the transition.</summary>
    public required PlanStatus NewStatus { get; init; }

    /// <summary>Gets the UTC time when this event was published.</summary>
    public required DateTimeOffset At { get; init; }
}
