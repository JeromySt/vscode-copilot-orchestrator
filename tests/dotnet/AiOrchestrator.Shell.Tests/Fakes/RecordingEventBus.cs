// <copyright file="RecordingEventBus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Abstractions.Eventing;

namespace AiOrchestrator.Shell.Tests.Fakes;

/// <summary>In-memory event bus that records every published event for assertions.</summary>
public sealed class RecordingEventBus : IEventBus
{
    /// <summary>Gets the queue of published events (any type) recorded so far.</summary>
    public ConcurrentQueue<object> Published { get; } = new();

    /// <inheritdoc/>
    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        this.Published.Enqueue(@event);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
        => new NoopSubscription();

    private sealed class NoopSubscription : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
