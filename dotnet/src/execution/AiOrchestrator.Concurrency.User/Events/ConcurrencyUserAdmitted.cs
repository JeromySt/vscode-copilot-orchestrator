// <copyright file="ConcurrencyUserAdmitted.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.User.Events;

/// <summary>Published when a queued job is admitted (slot granted after waiting).</summary>
public sealed class ConcurrencyUserAdmitted
{
    /// <summary>Gets the job that was admitted.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the duration the job waited in the queue before being admitted.</summary>
    public required TimeSpan WaitTime { get; init; }

    /// <summary>Gets the UTC timestamp when the slot was granted.</summary>
    public required DateTimeOffset At { get; init; }
}
