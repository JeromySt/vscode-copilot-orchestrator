// <copyright file="EventingCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using System.Threading.Channels;
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

/// <summary>Tests targeting uncovered branches in Eventing subsystems.</summary>
public sealed class EventingCoverageGapTests
{
    // ================================================================
    // DedupCache — null key, window expiry, eviction, concurrent race
    // ================================================================

    [Fact]
    public void DedupCache_NullKey_AlwaysReturnsFresh()
    {
        var clock = new InMemoryClock();
        var cache = new DedupCache(clock);

        Assert.True(cache.TryRegister(typeof(string), null, TimeSpan.FromSeconds(5)));
        Assert.True(cache.TryRegister(typeof(string), null, TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void DedupCache_SameKeyWithinWindow_ReturnsDuplicate()
    {
        var clock = new InMemoryClock();
        var cache = new DedupCache(clock);

        Assert.True(cache.TryRegister(typeof(string), "k1", TimeSpan.FromSeconds(5)));
        Assert.False(cache.TryRegister(typeof(string), "k1", TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void DedupCache_SameKeyAfterWindow_ReturnsFresh()
    {
        var clock = new InMemoryClock();
        var cache = new DedupCache(clock);

        Assert.True(cache.TryRegister(typeof(string), "k1", TimeSpan.FromSeconds(1)));
        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.True(cache.TryRegister(typeof(string), "k1", TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void DedupCache_DifferentEventTypes_SameKey_AreIndependent()
    {
        var clock = new InMemoryClock();
        var cache = new DedupCache(clock);

        Assert.True(cache.TryRegister(typeof(string), "k1", TimeSpan.FromSeconds(5)));
        Assert.True(cache.TryRegister(typeof(int), "k1", TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void DedupCache_Eviction_RemovesExpiredEntries()
    {
        var clock = new InMemoryClock();
        var cache = new DedupCache(clock);

        // Fill enough entries to trigger eviction (happens when count & 0x3F == 0, i.e. at multiples of 64)
        for (var i = 0; i < 64; i++)
        {
            cache.TryRegister(typeof(string), $"evict-{i}", TimeSpan.FromSeconds(1));
        }

        // Advance past the window
        clock.Advance(TimeSpan.FromSeconds(2));

        // Next register triggers eviction check
        Assert.True(cache.TryRegister(typeof(string), "trigger", TimeSpan.FromSeconds(1)));

        // Previously registered keys should now be expired and re-registrable
        Assert.True(cache.TryRegister(typeof(string), "evict-0", TimeSpan.FromSeconds(1)));
    }

    // ================================================================
    // Subscription — handler exception, dispose idempotent, dropped count
    // ================================================================

    [Fact]
    public async Task Subscription_HandlerThrows_ContinuesProcessing()
    {
        var received = new ConcurrentBag<string>();
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var channel = Channel.CreateBounded<DemoEvent>(new BoundedChannelOptions(16)
        {
            FullMode = BoundedChannelFullMode.Wait,
        });
        var removed = false;

        var sub = new Subscription<DemoEvent>(
            MakePrincipal("test"),
            new EventFilter { SubscribingPrincipal = MakePrincipal("test") },
            (e, _) =>
            {
                received.Add(e.Message);
                if (e.Message == "throw")
                    throw new InvalidOperationException("boom");
                if (e.Message == "done")
                    done.SetResult();
                return ValueTask.CompletedTask;
            },
            channel,
            16,
            BackpressureMode.Wait,
            NullLogger.Instance,
            _ => removed = true);

        await sub.Writer.WriteAsync(new DemoEvent("throw"));
        await sub.Writer.WriteAsync(new DemoEvent("ok"));
        await sub.Writer.WriteAsync(new DemoEvent("done"));

        await done.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Contains("throw", received);
        Assert.Contains("ok", received);
        Assert.Contains("done", received);
        await sub.DisposeAsync();
        Assert.True(removed);
    }

    [Fact]
    public async Task Subscription_DisposeAsync_IsIdempotent()
    {
        var channel = Channel.CreateBounded<DemoEvent>(16);
        var sub = new Subscription<DemoEvent>(
            MakePrincipal("test"),
            new EventFilter { SubscribingPrincipal = MakePrincipal("test") },
            (_, _) => ValueTask.CompletedTask,
            channel,
            16,
            BackpressureMode.Wait,
            NullLogger.Instance,
            _ => { });

        await sub.DisposeAsync();
        await sub.DisposeAsync(); // second dispose is a no-op
    }

    [Fact]
    public async Task Subscription_IncrementDropped_IncrementsCounter()
    {
        var channel = Channel.CreateBounded<DemoEvent>(16);
        var sub = new Subscription<DemoEvent>(
            MakePrincipal("test"),
            new EventFilter { SubscribingPrincipal = MakePrincipal("test") },
            (_, _) => ValueTask.CompletedTask,
            channel,
            16,
            BackpressureMode.Wait,
            NullLogger.Instance,
            _ => { });

        Assert.Equal(0, sub.DroppedCount);
        Assert.Equal(1, sub.IncrementDropped());
        Assert.Equal(2, sub.IncrementDropped());
        Assert.Equal(2, sub.DroppedCount);
        await sub.DisposeAsync();
    }

    [Fact]
    public async Task Subscription_Properties_AreCorrect()
    {
        var channel = Channel.CreateBounded<DemoEvent>(32);
        var principal = MakePrincipal("alice");
        var filter = new EventFilter { SubscribingPrincipal = principal };
        var sub = new Subscription<DemoEvent>(
            principal,
            filter,
            (_, _) => ValueTask.CompletedTask,
            channel,
            32,
            BackpressureMode.DropOldest,
            NullLogger.Instance,
            _ => { });

        Assert.Equal(typeof(DemoEvent), sub.EventType);
        Assert.Equal(32, sub.Capacity);
        Assert.Equal(BackpressureMode.DropOldest, sub.Mode);
        Assert.Equal(principal, sub.PrincipalAtSubscribe);
        Assert.NotEqual(Guid.Empty, sub.Id);
        Assert.Equal(0, sub.CurrentDepth);
        await sub.DisposeAsync();
    }

    // ================================================================
    // RedactionWalker — no string props, no constructor, non-record
    // ================================================================

    private sealed record NoStringEvent(int Count, double Value);

    private sealed record AllStringEvent(string Name, string Description);

    private sealed record MixedEvent(string Name, int Count);

    [Fact]
    public void RedactionWalker_NoStringProperties_ReturnsOriginal()
    {
        var original = new NoStringEvent(42, 3.14);
        var redactor = new PrefixRedactor();
        var result = RedactionWalker.Redact(original, redactor);

        Assert.Same(original, result);
    }

    [Fact]
    public void RedactionWalker_AllStringProperties_RedactsAll()
    {
        var original = new AllStringEvent("Alice", "Secret description");
        var redactor = new PrefixRedactor();
        var result = RedactionWalker.Redact(original, redactor);

        Assert.NotSame(original, result);
        Assert.Equal("[R]Alice", result.Name);
        Assert.Equal("[R]Secret description", result.Description);
    }

    [Fact]
    public void RedactionWalker_MixedProperties_RedactsOnlyStrings()
    {
        var original = new MixedEvent("Bob", 42);
        var redactor = new PrefixRedactor();
        var result = RedactionWalker.Redact(original, redactor);

        Assert.NotSame(original, result);
        Assert.Equal("[R]Bob", result.Name);
        Assert.Equal(42, result.Count);
    }

    [Fact]
    public void RedactionWalker_NullStringValue_PreservesNull()
    {
        var original = new AllStringEvent(null!, "visible");
        var redactor = new PrefixRedactor();
        var result = RedactionWalker.Redact(original, redactor);

        Assert.Null(result.Name);
        Assert.Equal("[R]visible", result.Description);
    }

    [Fact]
    public void RedactionWalker_IsCached_SecondCallUsesCache()
    {
        var redactor = new PrefixRedactor();
        var e1 = new AllStringEvent("a", "b");
        var e2 = new AllStringEvent("c", "d");

        var r1 = RedactionWalker.Redact(e1, redactor);
        var r2 = RedactionWalker.Redact(e2, redactor);

        Assert.Equal("[R]a", r1.Name);
        Assert.Equal("[R]c", r2.Name);
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static AuthContext MakePrincipal(string id) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = ImmutableArray<string>.Empty,
    };

    private sealed class PrefixRedactor : IRedactor
    {
        public string Redact(string value) => $"[R]{value}";

        public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct)
        {
            var span = input.FirstSpan;
            var dest = output.GetSpan((int)input.Length);
            span.CopyTo(dest);
            output.Advance((int)input.Length);
            return ValueTask.FromResult((int)input.Length);
        }
    }
}
