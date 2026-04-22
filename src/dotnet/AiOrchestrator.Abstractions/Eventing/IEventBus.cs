// <copyright file="IEventBus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Eventing;

/// <summary>
/// Provides publish-subscribe messaging for domain events, with authorization-aware
/// subscription filtering. Publishers are decoupled from subscribers.
/// </summary>
public interface IEventBus
{
    /// <summary>Publishes an event to all matching subscribers.</summary>
    /// <typeparam name="TEvent">The event type. Must be a non-null reference or value type.</typeparam>
    /// <param name="event">The event to publish.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when all subscribers have been notified.</returns>
    ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull;

    /// <summary>
    /// Subscribes to events of type <typeparamref name="TEvent"/> that match the given filter.
    /// Dispose the returned handle to unsubscribe.
    /// </summary>
    /// <typeparam name="TEvent">The event type to subscribe to.</typeparam>
    /// <param name="filter">The filter controlling which events are delivered to <paramref name="handler"/>.</param>
    /// <param name="handler">The asynchronous callback invoked for each matching event.</param>
    /// <returns>An <see cref="IAsyncDisposable"/> that removes the subscription when disposed.</returns>
    IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull;
}
