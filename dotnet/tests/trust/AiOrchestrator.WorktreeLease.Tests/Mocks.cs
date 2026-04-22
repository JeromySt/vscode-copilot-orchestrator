// <copyright file="Mocks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.WorktreeLease.Tests;

internal static class Mocks
{
    public static AuthContext TestPrincipal { get; } = new()
    {
        PrincipalId = "tester@example.com",
        DisplayName = "tester",
        Scopes = ImmutableArray<string>.Empty,
    };

    public static IOptionsMonitor<LeaseOptions> Opts(LeaseOptions? value = null)
        => new TestOpts(value ?? new LeaseOptions());

    private sealed class TestOpts(LeaseOptions value) : IOptionsMonitor<LeaseOptions>
    {
        public LeaseOptions CurrentValue => value;

        public LeaseOptions Get(string? name) => value;

        public IDisposable? OnChange(Action<LeaseOptions, string?> listener) => null;
    }
}

internal sealed class CapturingEventBus : IEventBus
{
    private readonly ConcurrentBag<object> events = new();
    private readonly List<Subscription> subs = new();

    public IReadOnlyCollection<object> Events => this.events.ToArray();

    public async ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        this.events.Add(@event);
        foreach (var s in this.subs.ToArray())
        {
            if (s.EventType == typeof(TEvent))
            {
                await s.Handler(@event, ct).ConfigureAwait(false);
            }
        }
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
    {
        var sub = new Subscription(typeof(TEvent), (o, c) => handler((TEvent)o, c), this);
        this.subs.Add(sub);
        return sub;
    }

    private sealed class Subscription(
        Type eventType,
        Func<object, CancellationToken, ValueTask> handler,
        CapturingEventBus owner) : IAsyncDisposable
    {
        public Type EventType => eventType;

        public Func<object, CancellationToken, ValueTask> Handler => handler;

        public ValueTask DisposeAsync()
        {
            _ = owner.subs.Remove(this);
            return ValueTask.CompletedTask;
        }
    }
}
