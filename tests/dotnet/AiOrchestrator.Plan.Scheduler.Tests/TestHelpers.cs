// <copyright file="TestHelpers.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using AiOrchestrator.Abstractions.Eventing;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "SCHED-RDY-1").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}

/// <summary>Thread-safe recording implementation of <see cref="IEventBus"/> for testing.</summary>
internal sealed class RecordingEventBus : IEventBus
{
    private readonly List<object> published = [];
    private readonly object syncRoot = new();

    /// <summary>Returns all published events of type <typeparamref name="T"/>.</summary>
    /// <typeparam name="T">The event type to filter.</typeparam>
    /// <returns>All events of the given type.</returns>
    public IReadOnlyList<T> Of<T>()
    {
        lock (this.syncRoot)
        {
            return this.published.OfType<T>().ToList();
        }
    }

    /// <inheritdoc/>
    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        lock (this.syncRoot)
        {
            this.published.Add(@event);
        }

        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
        => NullDisposable.Instance;

    private sealed class NullDisposable : IAsyncDisposable
    {
        public static readonly NullDisposable Instance = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

/// <summary>Simple <see cref="IOptionsMonitor{T}"/> that always returns a fixed value.</summary>
internal sealed class FixedOptions<T>(T value) : IOptionsMonitor<T>
{
    /// <inheritdoc/>
    public T CurrentValue => value;

    /// <inheritdoc/>
    public T Get(string? name) => value;

    /// <inheritdoc/>
    public IDisposable? OnChange(Action<T, string?> listener) => null;
}
