// <copyright file="EventingCoverageGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Eventing;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Eventing.Tests;

/// <summary>Targeted coverage-gap tests for Eventing assembly (~5 lines).</summary>
public sealed class EventingCoverageGap2Tests
{
    // ================================================================
    // EventBus — publish after dispose, subscribe after dispose
    // ================================================================

    [Fact]
    public async Task EventBus_PublishAfterDispose_ThrowsObjectDisposed()
    {
        var bus = BuildBus();
        await bus.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => bus.PublishAsync(new TestEvent("msg"), CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task EventBus_SubscribeAfterDispose_ThrowsObjectDisposed()
    {
        var bus = BuildBus();
        await bus.DisposeAsync();

        Assert.Throws<ObjectDisposedException>(() =>
            bus.Subscribe<TestEvent>(
                new EventFilter { SubscribingPrincipal = MakePrincipal("test") },
                (_, _) => ValueTask.CompletedTask));
    }

    [Fact]
    public async Task EventBus_DisposeAsync_IsIdempotent()
    {
        var bus = BuildBus();
        await bus.DisposeAsync();
        await bus.DisposeAsync(); // second dispose is a no-op
    }

    // ================================================================
    // EventBus — dedup enabled, duplicate events are dropped
    // ================================================================

    [Fact]
    public async Task EventBus_WithDedup_DropsDuplicateKeys()
    {
        var opts = new EventBusOptions
        {
            EnableDedup = true,
            DedupWindow = TimeSpan.FromSeconds(5),
            PerSubscriptionBufferSize = 16,
            Backpressure = BackpressureMode.Wait,
        };
        var bus = BuildBus(opts);
        var received = new ConcurrentBag<string>();
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        await using var sub = bus.Subscribe<DedupEvent>(
            new EventFilter { SubscribingPrincipal = MakePrincipal("test") },
            (e, _) =>
            {
                received.Add(e.Value);
                if (received.Count >= 2) done.TrySetResult();
                return ValueTask.CompletedTask;
            });

        // Publish twice with same dedup key — second should be dropped
        await bus.PublishAsync(new DedupEvent("a", "key1"), CancellationToken.None);
        await bus.PublishAsync(new DedupEvent("b", "key1"), CancellationToken.None);
        // Third with different key — should go through
        await bus.PublishAsync(new DedupEvent("c", "key2"), CancellationToken.None);

        await done.Task.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.Contains("a", received);
        Assert.Contains("c", received);
        Assert.DoesNotContain("b", received);
    }

    // ================================================================
    // EventBus — subscribe with null principal throws
    // ================================================================

    [Fact]
    public void EventBus_Subscribe_NullPrincipal_ThrowsArgException()
    {
        var bus = BuildBus();

        Assert.Throws<ArgumentException>(() =>
            bus.Subscribe<TestEvent>(
                new EventFilter { SubscribingPrincipal = null! },
                (_, _) => ValueTask.CompletedTask));
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static EventBus BuildBus(EventBusOptions? opts = null)
    {
        opts ??= new EventBusOptions
        {
            EnableDedup = false,
            PerSubscriptionBufferSize = 16,
            Backpressure = BackpressureMode.Wait,
        };
        return new EventBus(
            new InMemoryClock(),
            new NoOpRedactor(),
            NullLogger<EventBus>.Instance,
            new StaticOpts<EventBusOptions>(opts));
    }

    private static AuthContext MakePrincipal(string id) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = ImmutableArray<string>.Empty,
    };

    private sealed record TestEvent(string Message);

    private sealed record DedupEvent(string Value, string DedupKey);

    private sealed class NoOpRedactor : IRedactor
    {
        public string Redact(string value) => value;

        public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct)
        {
            var span = input.FirstSpan;
            var dest = output.GetSpan((int)input.Length);
            span.CopyTo(dest);
            output.Advance((int)input.Length);
            return ValueTask.FromResult((int)input.Length);
        }
    }

    private sealed class StaticOpts<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;
        public T Get(string? name) => value;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
