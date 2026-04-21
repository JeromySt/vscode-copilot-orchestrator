// <copyright file="ConsumerLagged.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Output;

/// <summary>
/// Event published on the <see cref="AiOrchestrator.Abstractions.Eventing.IEventBus"/> when a
/// per-consumer bounded channel overflows and a chunk is dropped for that consumer.
/// </summary>
public sealed class ConsumerLagged
{
    /// <summary>Gets the job whose consumer fell behind.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets which consumer dropped chunks.</summary>
    public required OutputConsumerKind Consumer { get; init; }

    /// <summary>Gets the total bytes dropped for this consumer since the last lag event.</summary>
    public required long DroppedBytes { get; init; }

    /// <summary>Gets the wall-clock time at which the drop was observed.</summary>
    public required DateTimeOffset At { get; init; }
}
