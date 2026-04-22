// <copyright file="EventFilter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Abstractions.Eventing;

/// <summary>
/// Specifies filter criteria used when subscribing to events on the <see cref="IEventBus"/>
/// or replaying events from <see cref="IEventReader"/>.
/// </summary>
public sealed record EventFilter
{
    /// <summary>Gets the principal whose authorization context governs what events are visible.</summary>
    public AuthContext SubscribingPrincipal { get; init; } = default!;

    /// <summary>Gets the plan ID to filter events by, or <see langword="null"/> to receive events for all plans.</summary>
    public PlanId? PlanId { get; init; }

    /// <summary>Gets the job ID to filter events by, or <see langword="null"/> to receive events for all jobs.</summary>
    public JobId? JobId { get; init; }

    /// <summary>Gets an optional additional predicate applied after the structural filters, or <see langword="null"/> for no extra filtering.</summary>
    public Func<EventEnvelope, bool>? Predicate { get; init; }
}
