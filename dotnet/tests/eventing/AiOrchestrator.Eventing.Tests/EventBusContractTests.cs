// <copyright file="EventBusContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Eventing;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Eventing.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

internal sealed record DemoEvent(string Message);

internal sealed record DemoDedupEvent(string Message, string DedupKey);

public sealed class EventBusContractTests
{
    // ---------------------------------------------------------------------
    // EVT-AUTH-1/2/3 — AuthContextFilter pinning behaviour
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-AUTH-1")]
    public void EVT_AUTH_1_FilterRespectsSubscribePrincipal()
    {
        var pinned = MakePrincipal("alice", "events:read:all");
        var filter = new EventFilter { SubscribingPrincipal = pinned };
        var envelope = MakeEnvelope(principalId: "alice");
        var sut = new AuthContextFilter();

        Assert.True(sut.Matches(filter, envelope, currentPrincipal: MakePrincipal("mallory")));
    }

    [Fact]
    [ContractTest("EVT-AUTH-2")]
    public void EVT_AUTH_2_PrincipalChangeDoesNotEscalate()
    {
        var pinned = MakePrincipal("alice"); // no wildcard scope
        var filter = new EventFilter { SubscribingPrincipal = pinned };
        var envelope = MakeEnvelope(principalId: "bob");
        var sut = new AuthContextFilter();

        // Even when the *current* caller is bob (or a super-user), filtering must use the pinned alice.
        var current = MakePrincipal("bob", AuthContextFilter.ReadAllScope);
        Assert.False(sut.Matches(filter, envelope, current));
    }

    [Fact]
    [ContractTest("EVT-AUTH-3")]
    public void EVT_AUTH_3_FilterRejectsCrossPrincipalReplay()
    {
        var pinned = MakePrincipal("alice"); // no wildcard
        var filter = new EventFilter { SubscribingPrincipal = pinned };
        var envelope = MakeEnvelope(principalId: "bob");
        var sut = new AuthContextFilter();

        Assert.False(sut.Matches(filter, envelope, currentPrincipal: pinned));
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-1 — Publish applies the redactor (INV-3)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-1")]
    public async Task EVT_BUS_1_Publish_AppliesRedactor()
    {
        var redactor = new SecretRedactor();
        await using var bus = MakeBus(redactor: redactor);

        var received = new TaskCompletionSource<DemoEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
        var sub = bus.Subscribe<DemoEvent>(MakeFilter(), (e, ct) =>
        {
            _ = received.TrySetResult(e);
            return ValueTask.CompletedTask;
        });

        await bus.PublishAsync(new DemoEvent("password=secret"), CancellationToken.None);

        var got = await received.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal("password=***", got.Message);
        Assert.True(redactor.Calls > 0);

        await sub.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-2 — Wait backpressure blocks the publisher (INV-5)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-2")]
    public async Task EVT_BUS_2_Backpressure_Wait_BlocksPublisher()
    {
        await using var bus = MakeBus(opts: new EventBusOptions
        {
            PerSubscriptionBufferSize = 1,
            Backpressure = BackpressureMode.Wait,
        });

        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sub = bus.Subscribe<DemoEvent>(MakeFilter(), async (_, _) =>
        {
            await release.Task;
        });

        // First publish fills the buffer (1 slot) and is consumed by the handler that is blocked.
        await bus.PublishAsync(new DemoEvent("a"), CancellationToken.None);
        // Second publish fills the buffer.
        await bus.PublishAsync(new DemoEvent("b"), CancellationToken.None);

        // Third publish must block until the handler releases.
        var blocked = bus.PublishAsync(new DemoEvent("c"), CancellationToken.None).AsTask();
        var winner = await Task.WhenAny(blocked, Task.Delay(150));
        Assert.NotEqual(blocked, winner);

        release.SetResult();
        await blocked.WaitAsync(TimeSpan.FromSeconds(2));
        await sub.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-3 — DropOldest emits a lagged event
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-3")]
    public async Task EVT_BUS_3_Backpressure_DropOldest_EmitsLaggedEvent()
    {
        await using var bus = MakeBus(opts: new EventBusOptions
        {
            PerSubscriptionBufferSize = 1,
            Backpressure = BackpressureMode.DropOldest,
        });

        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var laggedSeen = new TaskCompletionSource<EventBusSubscriptionLagged>(TaskCreationOptions.RunContinuationsAsynchronously);

        var demoSub = bus.Subscribe<DemoEvent>(MakeFilter(), async (_, _) => await hold.Task);
        var laggedSub = bus.Subscribe<EventBusSubscriptionLagged>(MakeFilter(), (lag, ct) =>
        {
            _ = laggedSeen.TrySetResult(lag);
            return ValueTask.CompletedTask;
        });

        for (var i = 0; i < 10; i++)
        {
            await bus.PublishAsync(new DemoEvent($"e{i}"), CancellationToken.None);
        }

        var lag = await laggedSeen.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(BackpressureMode.DropOldest, lag.Mode);
        Assert.True(lag.DroppedCount > 0);

        hold.SetResult();
        await demoSub.DisposeAsync();
        await laggedSub.DisposeAsync();
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-4 — Subscribe returns IAsyncDisposable; dispose drains queue (INV-6)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-4")]
    public async Task EVT_BUS_4_Subscribe_ReturnsAsyncDisposable_DrainsOnDispose()
    {
        await using var bus = MakeBus();

        var seen = new ConcurrentBag<string>();
        var sub = bus.Subscribe<DemoEvent>(MakeFilter(), (e, _) =>
        {
            seen.Add(e.Message);
            return ValueTask.CompletedTask;
        });

        Assert.IsAssignableFrom<IAsyncDisposable>(sub);

        for (var i = 0; i < 10; i++)
        {
            await bus.PublishAsync(new DemoEvent($"e{i}"), CancellationToken.None);
        }

        await sub.DisposeAsync();
        Assert.Equal(10, seen.Count);
    }

    // ---------------------------------------------------------------------
    // CONC-CHAN-2 — Dedup-by-event-key (INV-4)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("CONC-CHAN-2")]
    public async Task CONC_CHAN_2_DedupesByEventKey()
    {
        var clock = new InMemoryClock();
        await using var bus = MakeBus(
            clock: clock,
            opts: new EventBusOptions
            {
                PerSubscriptionBufferSize = 64,
                EnableDedup = true,
                DedupWindow = TimeSpan.FromSeconds(5),
            });

        var seen = new ConcurrentBag<DemoDedupEvent>();
        var sub = bus.Subscribe<DemoDedupEvent>(MakeFilter(), (e, _) =>
        {
            seen.Add(e);
            return ValueTask.CompletedTask;
        });

        await bus.PublishAsync(new DemoDedupEvent("hello", "k1"), CancellationToken.None);
        await bus.PublishAsync(new DemoDedupEvent("hello", "k1"), CancellationToken.None);
        await bus.PublishAsync(new DemoDedupEvent("hello", "k2"), CancellationToken.None);

        await Task.Delay(100); // give the reader loop a chance to drain
        await sub.DisposeAsync();

        Assert.Equal(2, seen.Count);
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-5 — Roslyn no-locks scan + concurrent publisher load test (INV-7)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-5")]
    public void EVT_BUS_5_NoLocksOnPublishPath()
    {
        var src = ReadEmbeddedSource("EventBus.cs");
        var publishBlock = ExtractMethodBody(src, "PublishAsync");
        Assert.DoesNotContain("lock(", publishBlock);
        Assert.DoesNotContain("Monitor.Enter", publishBlock);
        Assert.DoesNotContain("SemaphoreSlim", publishBlock);
    }

    [Fact]
    [ContractTest("EVT-BUS-5")]
    public async Task EVT_BUS_5_ConcurrentPublishersLoadTest()
    {
        await using var bus = MakeBus(opts: new EventBusOptions
        {
            PerSubscriptionBufferSize = 256,
            Backpressure = BackpressureMode.DropOldest,
        });

        var subs = new List<IAsyncDisposable>();
        var counters = new int[100];
        for (var i = 0; i < 100; i++)
        {
            var idx = i;
            subs.Add(bus.Subscribe<DemoEvent>(MakeFilter(), (_, _) =>
            {
                Interlocked.Increment(ref counters[idx]);
                return ValueTask.CompletedTask;
            }));
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var publishers = Enumerable.Range(0, 8).Select(_ => Task.Run(async () =>
        {
            for (var i = 0; i < 1250; i++)
            {
                await bus.PublishAsync(new DemoEvent("x"), CancellationToken.None);
            }
        })).ToArray();
        await Task.WhenAll(publishers);
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));

        foreach (var s in subs)
        {
            await s.DisposeAsync();
        }
    }

    // ---------------------------------------------------------------------
    // EVT-BUS-6 — DisposeAsync graceful with 5s timeout (INV-8)
    // ---------------------------------------------------------------------
    [Fact]
    [ContractTest("EVT-BUS-6")]
    public async Task EVT_BUS_6_DisposeAsync_GracefulWithTimeout()
    {
        var bus = MakeBus();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = bus.Subscribe<DemoEvent>(MakeFilter(), async (_, _) => await release.Task);

        await bus.PublishAsync(new DemoEvent("a"), CancellationToken.None);

        // Free up the handler so dispose drains gracefully (well within the 5 s budget).
        release.SetResult();

        var sw = System.Diagnostics.Stopwatch.StartNew();
        await bus.DisposeAsync();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
    }

    // ---------------------------------------------------------------------
    // Additional coverage tests
    // ---------------------------------------------------------------------
    [Fact]
    public void AuthContextFilter_NullPinned_ReturnsFalse()
    {
        var sut = new AuthContextFilter();
        var filter = new EventFilter { SubscribingPrincipal = null! };
        Assert.False(sut.Matches(filter, MakeEnvelope("alice"), MakePrincipal("alice")));
    }

    [Fact]
    public void AuthContextFilter_PlanIdMismatch_ReturnsFalse()
    {
        var sut = new AuthContextFilter();
        var filter = new EventFilter
        {
            SubscribingPrincipal = MakePrincipal("alice"),
            PlanId = AiOrchestrator.Models.Ids.PlanId.New(),
        };
        var env = MakeEnvelope("alice");
        Assert.False(sut.Matches(filter, env, MakePrincipal("alice")));
    }

    [Fact]
    public void AuthContextFilter_JobIdMismatch_ReturnsFalse()
    {
        var sut = new AuthContextFilter();
        var filter = new EventFilter
        {
            SubscribingPrincipal = MakePrincipal("alice"),
            JobId = AiOrchestrator.Models.Ids.JobId.New(),
        };
        Assert.False(sut.Matches(filter, MakeEnvelope("alice"), MakePrincipal("alice")));
    }

    [Fact]
    public void AuthContextFilter_PredicateRejects_ReturnsFalse()
    {
        var sut = new AuthContextFilter();
        var filter = new EventFilter
        {
            SubscribingPrincipal = MakePrincipal("alice"),
            Predicate = _ => false,
        };
        Assert.False(sut.Matches(filter, MakeEnvelope("alice"), MakePrincipal("alice")));
    }

    [Fact]
    public void AuthContextFilter_NullEnvelopePrincipal_Allowed()
    {
        var sut = new AuthContextFilter();
        var filter = new EventFilter { SubscribingPrincipal = MakePrincipal("alice") };
        Assert.True(sut.Matches(filter, MakeEnvelope(principalId: null), MakePrincipal("alice")));
    }

    [Fact]
    public async Task PublishAsync_BackpressureThrow_RaisesEventBusFullException()
    {
        await using var bus = MakeBus(opts: new EventBusOptions
        {
            PerSubscriptionBufferSize = 1,
            Backpressure = BackpressureMode.Throw,
        });

        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = bus.Subscribe<DemoEvent>(MakeFilter(), async (_, _) => await hold.Task);

        await bus.PublishAsync(new DemoEvent("a"), CancellationToken.None);

        // Wait until the handler has picked up the first item and the buffer is empty,
        // then keep publishing until the channel becomes full.
        Func<Task> act = async () =>
        {
            for (var i = 0; i < 10; i++)
            {
                await bus.PublishAsync(new DemoEvent($"x{i}"), CancellationToken.None);
            }
        };

        await Assert.ThrowsAsync<EventBusFullException>(act);
        hold.SetResult();
    }

    [Fact]
    public async Task PublishAsync_BackpressureDropNewest_DoesNotBlockPublisher()
    {
        await using var bus = MakeBus(opts: new EventBusOptions
        {
            PerSubscriptionBufferSize = 1,
            Backpressure = BackpressureMode.DropNewest,
        });

        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = bus.Subscribe<DemoEvent>(MakeFilter(), async (_, _) => await hold.Task);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 0; i < 25; i++)
        {
            await bus.PublishAsync(new DemoEvent($"x{i}"), CancellationToken.None);
        }

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1));
        hold.SetResult();
    }

    [Fact]
    public async Task DedupCache_AfterWindow_AllowsRepublish()
    {
        var clock = new InMemoryClock();
        await using var bus = MakeBus(
            clock: clock,
            opts: new EventBusOptions
            {
                PerSubscriptionBufferSize = 64,
                EnableDedup = true,
                DedupWindow = TimeSpan.FromSeconds(1),
            });

        var seen = new ConcurrentBag<DemoDedupEvent>();
        var sub = bus.Subscribe<DemoDedupEvent>(MakeFilter(), (e, _) =>
        {
            seen.Add(e);
            return ValueTask.CompletedTask;
        });

        await bus.PublishAsync(new DemoDedupEvent("a", "k"), CancellationToken.None);
        clock.Advance(TimeSpan.FromSeconds(2));
        await bus.PublishAsync(new DemoDedupEvent("a", "k"), CancellationToken.None);

        await Task.Delay(100);
        await sub.DisposeAsync();
        Assert.Equal(2, seen.Count);
    }

    [Fact]
    public async Task PublishAsync_HandlerThrows_ReaderLoopContinues()
    {
        await using var bus = MakeBus();
        var seen = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sub = bus.Subscribe<DemoEvent>(MakeFilter(), (e, _) =>
        {
            var n = Interlocked.Increment(ref seen);
            if (n == 1)
            {
                throw new InvalidOperationException("boom");
            }

            if (n == 2)
            {
                release.SetResult();
            }

            return ValueTask.CompletedTask;
        });

        await bus.PublishAsync(new DemoEvent("a"), CancellationToken.None);
        await bus.PublishAsync(new DemoEvent("b"), CancellationToken.None);

        await release.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await sub.DisposeAsync();
        Assert.True(seen >= 2);
    }

    [Fact]
    public async Task PublishAsync_NullEvent_Throws()
    {
        await using var bus = MakeBus();
        Func<Task> act = async () =>
            await bus.PublishAsync<DemoEvent>(null!, CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    [Fact]
    public async Task Subscribe_NullPrincipal_Throws()
    {
        await using var bus = MakeBus();
        var filter = new EventFilter { SubscribingPrincipal = null! };
        Action act = () => bus.Subscribe<DemoEvent>(filter, (_, _) => ValueTask.CompletedTask);
        Assert.Throws<ArgumentException>(act);
    }

    [Fact]
    public async Task PublishAsync_AfterDispose_Throws()
    {
        var bus = MakeBus();
        await bus.DisposeAsync();
        Func<Task> act = async () =>
            await bus.PublishAsync(new DemoEvent("x"), CancellationToken.None);
        await Assert.ThrowsAsync<ObjectDisposedException>(act);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------
    private static EventBus MakeBus(
        IClock? clock = null,
        IRedactor? redactor = null,
        EventBusOptions? opts = null)
    {
        var c = clock ?? new InMemoryClock();
        var r = redactor ?? new NoopRedactor();
        var monitor = new TestOptionsMonitor<EventBusOptions>(opts ?? new EventBusOptions());
        return new EventBus(c, r, NullLogger<EventBus>.Instance, monitor);
    }

    private static EventFilter MakeFilter() => new()
    {
        SubscribingPrincipal = MakePrincipal("test"),
    };

    private static AuthContext MakePrincipal(string id, params string[] scopes) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = scopes.ToImmutableArray(),
    };

    private static EventEnvelope MakeEnvelope(string? principalId = null) => new()
    {
        EventId = Guid.NewGuid(),
        RecordSeq = 1,
        OccurredAtUtc = DateTimeOffset.UtcNow,
        EventType = "test.event",
        SchemaVersion = 1,
        Payload = JsonDocument.Parse("{}").RootElement.Clone(),
        PrincipalId = principalId,
    };

    private static string ReadEmbeddedSource(string fileName)
    {
        // Walk up from the test assembly to the repo and read EventBus.cs directly.
        var asmDir = Path.GetDirectoryName(typeof(EventBusContractTests).Assembly.Location)!;
        var dir = new DirectoryInfo(asmDir);
        while (dir is not null)
        {
            // climb until repo root
            if (Directory.Exists(Path.Combine(dir.FullName, "dotnet", "src")))
            {
                break;
            }

            dir = dir.Parent;
        }

        if (dir is null)
        {
            throw new FileNotFoundException("Could not locate repo root.");
        }

        var path = Path.Combine(dir.FullName, "dotnet", "src", "eventing", "AiOrchestrator.Eventing", fileName);
        return File.ReadAllText(path);
    }

    private static string ExtractMethodBody(string src, string methodName)
    {
        var idx = src.IndexOf("ValueTask PublishAsync<", StringComparison.Ordinal);
        if (idx < 0)
        {
            idx = src.IndexOf(methodName, StringComparison.Ordinal);
        }

        if (idx < 0)
        {
            return string.Empty;
        }

        // Find first '{' after idx, then scan to matching brace.
        var open = src.IndexOf('{', idx);
        if (open < 0)
        {
            return string.Empty;
        }

        var depth = 0;
        for (var i = open; i < src.Length; i++)
        {
            if (src[i] == '{')
            {
                depth++;
            }
            else if (src[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return src.Substring(open, i - open + 1);
                }
            }
        }

        return src[open..];
    }
}

internal sealed class NoopRedactor : IRedactor
{
    public string Redact(string input) => input;

    public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct) =>
        ValueTask.FromResult(0);
}

internal sealed class SecretRedactor : IRedactor
{
    private int calls;

    public int Calls => Volatile.Read(ref this.calls);

    public string Redact(string input)
    {
        Interlocked.Increment(ref this.calls);
        return input.Replace("secret", "***", StringComparison.Ordinal);
    }

    public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct) =>
        ValueTask.FromResult(0);
}

internal sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    private T current;

    public TestOptionsMonitor(T initial)
    {
        this.current = initial;
    }

    public T CurrentValue => this.current;

    public T Get(string? name) => this.current;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}
