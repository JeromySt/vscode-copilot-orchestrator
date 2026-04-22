// <copyright file="EventEnvelope.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Models.Eventing;

/// <summary>An immutable envelope carrying a domain event through the event store and bus.</summary>
public sealed record EventEnvelope
{
    /// <summary>Gets the unique identifier for this event instance.</summary>
    public required Guid EventId { get; init; }

    /// <summary>Gets the monotonically increasing sequence number assigned by the event store.</summary>
    /// <remarks>Must be greater than 0.</remarks>
    public required long RecordSeq { get; init; }

    /// <summary>Gets the UTC time at which the event occurred.</summary>
    public required DateTimeOffset OccurredAtUtc { get; init; }

    /// <summary>Gets the fully qualified event type discriminator string.</summary>
    public required string EventType { get; init; }

    /// <summary>Gets the schema version of the event payload.</summary>
    public required int SchemaVersion { get; init; }

    /// <summary>Gets the raw JSON payload of the event.</summary>
    public required JsonElement Payload { get; init; }

    /// <summary>Gets the plan ID associated with this event, if any.</summary>
    public PlanId? PlanId { get; init; }

    /// <summary>Gets the job ID associated with this event, if any.</summary>
    public JobId? JobId { get; init; }

    /// <summary>Gets the principal ID of the actor who caused this event, if any.</summary>
    public string? PrincipalId { get; init; }
}
