// <copyright file="FairnessDecision.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Concurrency.Broker.Fairness;

/// <summary>The result returned by <see cref="FairnessScheduler.EnqueueAsync"/> when a request is admitted.</summary>
public sealed record FairnessDecision
{
    /// <summary>Gets the broker-assigned lease identifier for this admission.</summary>
    public required string LeaseId { get; init; }

    /// <summary>Gets the estimated time the request spent (or will spend) waiting.</summary>
    public required TimeSpan EstimatedWait { get; init; }

    /// <summary>Gets the zero-based position this request occupied in the queue before admission.</summary>
    public required int QueuePosition { get; init; }
}
