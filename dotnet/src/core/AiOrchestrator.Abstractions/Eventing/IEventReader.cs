// <copyright file="IEventReader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.Abstractions.Eventing;

/// <summary>
/// Combines historical event replay with live event streaming through a single async enumerable.
/// Callers receive all historical events matching the filter first, then continue receiving
/// new events as they are published, until the cancellation token is cancelled.
/// </summary>
public interface IEventReader
{
    /// <summary>
    /// Begins reading events matching <paramref name="filter"/> from the beginning of history,
    /// then transitions seamlessly to live events.
    /// </summary>
    /// <param name="filter">The filter controlling which events are returned.</param>
    /// <param name="ct">Cancellation token. Cancel to stop the stream.</param>
    /// <returns>An async enumerable that first yields historical events, then live events.</returns>
    IAsyncEnumerable<EventEnvelope> ReadReplayAndLiveAsync(EventFilter filter, CancellationToken ct);
}
