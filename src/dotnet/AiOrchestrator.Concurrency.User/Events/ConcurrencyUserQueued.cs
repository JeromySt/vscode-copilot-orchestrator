// <copyright file="ConcurrencyUserQueued.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.User.Events;

/// <summary>Published when a job request enters the per-user FIFO wait queue.</summary>
public sealed class ConcurrencyUserQueued
{
    /// <summary>Gets the job that entered the queue.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the zero-based position in the queue when the job was enqueued.</summary>
    public required int QueuePosition { get; init; }

    /// <summary>Gets the UTC timestamp when the job was queued.</summary>
    public DateTimeOffset At { get; init; }
}
