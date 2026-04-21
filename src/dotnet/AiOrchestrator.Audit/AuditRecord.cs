// <copyright file="AuditRecord.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Audit;

/// <summary>An immutable, append-only audit record covering a single security-relevant action.</summary>
public sealed record AuditRecord
{
    /// <summary>Gets a short identifier for the type of event being recorded.</summary>
    public required string EventType { get; init; }

    /// <summary>Gets the wall-clock instant at which the event occurred.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets the principal context that performed the action.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets a JSON-encoded structured payload with event-specific details.</summary>
    public required string ContentJson { get; init; }

    /// <summary>Gets the resource identifiers affected by the action.</summary>
    public required ImmutableArray<string> ResourceRefs { get; init; }
}
