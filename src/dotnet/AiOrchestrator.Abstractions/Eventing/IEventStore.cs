// <copyright file="IEventStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.Abstractions.Eventing;

/// <summary>
/// Provides durable, append-only storage of event envelopes with sequential record numbers.
/// Implementations must guarantee that <see cref="EventEnvelope.RecordSeq"/> values are
/// strictly monotonically increasing.
/// </summary>
public interface IEventStore
{
    /// <summary>Appends a single event envelope to the store.</summary>
    /// <param name="envelope">The event envelope to persist.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the envelope has been durably written.</returns>
    ValueTask AppendAsync(EventEnvelope envelope, CancellationToken ct);

    /// <summary>
    /// Returns an async sequence of all event envelopes whose <see cref="EventEnvelope.RecordSeq"/>
    /// is greater than or equal to <paramref name="fromRecordSeq"/>.
    /// </summary>
    /// <param name="fromRecordSeq">The inclusive starting record sequence number.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async enumerable of matching envelopes in ascending sequence order.</returns>
    IAsyncEnumerable<EventEnvelope> ReadFromAsync(long fromRecordSeq, CancellationToken ct);
}
