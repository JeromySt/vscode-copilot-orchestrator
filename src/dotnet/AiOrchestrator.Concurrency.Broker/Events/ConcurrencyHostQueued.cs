// <copyright file="ConcurrencyHostQueued.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.Broker.Events;

/// <summary>
/// Published when a job is placed in the host-wide concurrency queue because the
/// host-level slot pool is exhausted.
/// Satisfies CONC-BROKER-HINT: includes <see cref="ActionableHint"/> and <see cref="EtaSeconds"/>.
/// </summary>
public sealed class ConcurrencyHostQueued
{
    /// <summary>Gets the principal whose request was queued.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the job that is waiting for a host-level slot.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the zero-based position of this request in the host queue.</summary>
    public required int QueuePosition { get; init; }

    /// <summary>Gets the estimated wait time derived from the 30-second admission-rate window.</summary>
    public required TimeSpan EtaSeconds { get; init; }

    /// <summary>
    /// Gets a human-readable actionable hint (e.g. "5 jobs ahead from same user,
    /// consider raising MaxConcurrentPerUser").
    /// </summary>
    public required string ActionableHint { get; init; }

    /// <summary>Gets the UTC timestamp when the request was queued.</summary>
    public required DateTimeOffset At { get; init; }
}
