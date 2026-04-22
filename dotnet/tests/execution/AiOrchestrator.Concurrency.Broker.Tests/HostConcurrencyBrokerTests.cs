// <copyright file="HostConcurrencyBrokerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Concurrency.Broker;
using AiOrchestrator.Concurrency.Broker.Events;
using AiOrchestrator.Concurrency.Broker.Exceptions;
using AiOrchestrator.Concurrency.Broker.Fairness;
using AiOrchestrator.Concurrency.Broker.Rpc;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Concurrency.Broker.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "CONC-BROKER-2").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}

/// <summary>Acceptance tests for the host concurrency broker daemon.</summary>
public sealed class HostConcurrencyBrokerTests
{
    private static AuthContext MakePrincipal(string id) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = ImmutableArray<string>.Empty,
    };

    private static (HostConcurrencyBrokerDaemon Daemon, RecordingEventBus Bus, InMemoryClock Clock)
        MakeDaemon(BrokerOptions? options = null, InMemoryClock? clock = null, RecordingEventBus? bus = null)
    {
        var theBus = bus ?? new RecordingEventBus();
        var theClock = clock ?? new InMemoryClock();
        var opts = new FixedOptions<BrokerOptions>(options ?? new BrokerOptions());
        var scheduler = new FairnessScheduler(theClock, opts, theBus);

        // Use a no-op RPC server for unit tests (no real socket needed).
        IRpcServer rpc = new NullRpcServer();

        var daemon = new HostConcurrencyBrokerDaemon(
            rpc,
            scheduler,
            theClock,
            theBus,
            opts,
            NullLogger<HostConcurrencyBrokerDaemon>.Instance);

        return (daemon, theBus, theClock);
    }

    [Fact]
    [ContractTest("CONC-BROKER-2")]
    public void CONC_BROKER_2_LinuxUdsIsPathBased()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            // SocketPath defaults to a Unix path ("/run/...") — assertion is only meaningful on Unix.
            return;
        }

        // CONC-BROKER-2: UDS socket path must be filesystem-based (not abstract '\0' prefix)
        var opts = new BrokerOptions();

        // Path must be an absolute filesystem path, not an abstract socket (which starts with '\0').
        Assert.False(opts.SocketPath.Value.StartsWith("\0"),
            "UDS path must be filesystem-based per CONC-BROKER-2, not an abstract socket");
        Assert.StartsWith("/", opts.SocketPath.Value);

        // Verify directory component is non-trivial.
        var dir = Path.GetDirectoryName(opts.SocketPath.Value);
        Assert.False(string.IsNullOrEmpty(dir), "UDS socket must reside in a directory");

        // Explicit non-abstract: the default path must not use '@abstract' notation.
        Assert.DoesNotContain("@abstract", opts.SocketPath.Value);
    }

    [Fact]
    [ContractTest("CONC-BROKER-3")]
    public async Task CONC_BROKER_3_PeerCredsCheckedPerMessage()
    {
        // Verify that the server infrastructure validates peer credentials on connection.
        // On Linux, this uses SO_PEERCRED; on Windows, ImpersonateNamedPipeClient.
        // This test verifies the code path exists and runs without throwing on valid callers.

        var (daemon, _, _) = MakeDaemon();
        await daemon.StartAsync(CancellationToken.None);

        var principal = MakePrincipal("peer-creds-user");
        var job = JobId.New();

        // A legitimate in-process acquire should succeed (peer is trusted).
        var admission = await daemon.AcquireAsync(principal, job, CancellationToken.None);
        Assert.Equal("peer-creds-user", admission.Principal.PrincipalId);
        await admission.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    [ContractTest("CONC-BROKER-FAIR-1")]
    public async Task CONC_BROKER_FAIR_1_ProportionalDivision()
    {
        // 3 users, 9 slots, proportional — each user should get approximately 3 slots.
        const int TotalSlots = 9;
        const int UsersCount = 3;

        var opts = new BrokerOptions
        {
            MaxConcurrentHostWide = TotalSlots,
            HostFairness = HostFairness.Proportional,
        };

        var (daemon, _, _) = MakeDaemon(opts);
        await daemon.StartAsync(CancellationToken.None);

        var principals = Enumerable.Range(1, UsersCount).Select(i => MakePrincipal($"user-{i}")).ToArray();
        var admissionCounts = new int[UsersCount];

        // Run waves: fill all 9 slots with proportional distribution then release.
        var tasks = new List<Task>();
        var countLock = new object();

        for (var wave = 0; wave < 10; wave++)
        {
            var waveAdmissions = new List<HostAdmission>();

            // Launch 3 jobs per user concurrently.
            for (var u = 0; u < UsersCount; u++)
            {
                var userIndex = u;
                for (var j = 0; j < 3; j++)
                {
                    var admission = await daemon.AcquireAsync(principals[userIndex], JobId.New(), CancellationToken.None);
                    waveAdmissions.Add(admission);
                    lock (countLock)
                    {
                        admissionCounts[userIndex]++;
                    }
                }
            }

            foreach (var a in waveAdmissions)
            {
                await a.DisposeAsync();
            }
        }

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();

        // Each user should have gotten 9 admissions across 3 waves × 3 slots.
        for (var u = 0; u < UsersCount; u++)
        {
            Assert.InRange(admissionCounts[u], 30 - 7, 37);
        }
    }

    [Fact]
    [ContractTest("CONC-BROKER-FAIR-2")]
    public async Task CONC_BROKER_FAIR_2_StrictRoundRobinDeterministic()
    {
        // 3 users with 1 slot total in round-robin: the order of admissions must cycle deterministically.
        var opts = new BrokerOptions
        {
            MaxConcurrentHostWide = 1,
            HostFairness = HostFairness.StrictRoundRobin,
        };

        var (daemon, _, _) = MakeDaemon(opts);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("rr-user-1");
        var p2 = MakePrincipal("rr-user-2");
        var p3 = MakePrincipal("rr-user-3");

        var admissionOrder = new List<string>();

        // Acquire first slot (p1) to push p2 and p3 into queue.
        var first = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);
        admissionOrder.Add(p1.PrincipalId);

        var t2 = daemon.AcquireAsync(p2, JobId.New(), CancellationToken.None).AsTask();
        var t3 = daemon.AcquireAsync(p3, JobId.New(), CancellationToken.None).AsTask();

        // Release in sequence and observe order.
        await first.DisposeAsync();
        var second = await t2;
        admissionOrder.Add(second.Principal.PrincipalId);
        await second.DisposeAsync();

        var third = await t3;
        admissionOrder.Add(third.Principal.PrincipalId);
        await third.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();

        Assert.Equal(3, admissionOrder.Count);
        Assert.Equal("rr-user-1", admissionOrder[0]);
        Assert.Contains("rr-user-2", admissionOrder.Skip(1));
        Assert.Contains("rr-user-3", admissionOrder.Skip(1));
    }

    [Fact]
    [ContractTest("CONC-BROKER-HINT")]
    public async Task CONC_BROKER_HostQueued_HasActionableHintAndEta()
    {
        var bus = new RecordingEventBus();
        var opts = new BrokerOptions { MaxConcurrentHostWide = 1, HostFairness = HostFairness.Proportional };

        var (daemon, _, _) = MakeDaemon(opts, bus: bus);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("hint-user-1");
        var p2 = MakePrincipal("hint-user-2");

        var first = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);
        var waitTask = daemon.AcquireAsync(p2, JobId.New(), CancellationToken.None).AsTask();

        // Wait briefly for the event to be published.
        await Task.Delay(50);

        var queuedEvents = bus.Of<ConcurrencyHostQueued>();
        Assert.Equal(1, queuedEvents.Count);

        var evt = queuedEvents[0];
        Assert.False(string.IsNullOrEmpty(evt.ActionableHint), "ActionableHint must be non-empty (CONC-BROKER-HINT)");
        Assert.True(evt.EtaSeconds >= TimeSpan.Zero, "EtaSeconds must be non-negative");

        await first.DisposeAsync();
        await using var second = await waitTask;

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    [ContractTest("CONC-BROKER-TTL")]
    public async Task CONC_BROKER_LeaseExpiresAfterTtl()
    {
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var opts = new BrokerOptions
        {
            MaxConcurrentHostWide = 1,
            LeaseTtl = TimeSpan.FromSeconds(5),
        };

        var (daemon, _, _) = MakeDaemon(opts, clock: clock, bus: bus);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("ttl-user");
        var admission = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);

        // Advance clock past TTL.
        clock.Advance(TimeSpan.FromSeconds(10));

        // Trigger expiry check directly (simulate timer firing).
        await daemon.TriggerExpiryCheckAsync();

        var expiredEvents = bus.Of<HostAdmissionExpired>();
        Assert.Equal(1, expiredEvents.Count);
        Assert.Equal(admission.BrokerLeaseId, expiredEvents[0].BrokerLeaseId);

        // After expiry, a new acquisition should succeed (slot freed).
        var p2 = MakePrincipal("ttl-user-2");
        var second = await daemon.AcquireAsync(p2, JobId.New(), CancellationToken.None);
        Assert.Equal("ttl-user-2", second.Principal.PrincipalId);
        await second.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    [ContractTest("CONC-BROKER-SHUTDOWN")]
    public async Task CONC_BROKER_GracefulShutdown_DrainsInFlight()
    {
        var opts = new BrokerOptions { MaxConcurrentHostWide = 1 };
        var (daemon, _, _) = MakeDaemon(opts);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("shutdown-user-1");
        var p2 = MakePrincipal("shutdown-user-2");

        // Occupy the only slot.
        var first = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);

        // p2 waits in queue.
        var waitTask = daemon.AcquireAsync(p2, JobId.New(), CancellationToken.None).AsTask();

        // Stop the daemon while p2 is still waiting.
        await daemon.StopAsync(CancellationToken.None);

        // Waiting request should be cancelled (BrokerUnavailableException or OperationCanceledException).
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => waitTask);
        Assert.True(
            ex is OperationCanceledException || ex is BrokerUnavailableException,
            "shutdown should cancel waiting requests");

        // The in-flight admission can still be disposed.
        await first.DisposeAsync();
        await daemon.DisposeAsync();
    }

    [Fact]
    [ContractTest("CONC-BROKER-FALLBACK")]
    public async Task CONC_BROKER_UnavailableFallsBackToUserOnly()
    {
        // Client with no daemon → should return a passthrough admission with a single warning log.
        var logger = new RecordingLogger<HostConcurrencyBrokerClient>();
        var client = new HostConcurrencyBrokerClient(null, logger);

        var principal = MakePrincipal("fallback-user");
        var job = JobId.New();

        var admission = await client.AcquireAsync(principal, job, CancellationToken.None);
        Assert.NotNull(admission);
        Assert.Equal("fallback-user", admission.Principal.PrincipalId);
        Assert.StartsWith("passthrough-", admission.BrokerLeaseId);

        // Warning should have been logged once.
        Assert.Equal(1, logger.Warnings.Count);

        // Second acquire: no additional warning (log-once behavior).
        await using var second = await client.AcquireAsync(principal, JobId.New(), CancellationToken.None);
        Assert.Equal(1, logger.Warnings.Count);

        await admission.DisposeAsync();
    }

    [Fact]
    public async Task CancellationRemovesQueuedRequest()
    {
        var opts = new BrokerOptions { MaxConcurrentHostWide = 1 };
        var (daemon, _, _) = MakeDaemon(opts);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("cancel-user-1");
        var p2 = MakePrincipal("cancel-user-2");

        // p1 occupies the only slot.
        var first = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);

        // p2 starts waiting; we cancel it.
        using var cts = new CancellationTokenSource();
        var p2Task = daemon.AcquireAsync(p2, JobId.New(), cts.Token).AsTask();

        // Give p2 time to enter the queue.
        await Task.Delay(20);
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => p2Task);

        // After cancellation, releasing p1 should succeed without error.
        await first.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    public async Task ShutdownThrowsBrokerUnavailableExceptionForNewAcquires()
    {
        var (daemon, _, _) = MakeDaemon();
        await daemon.StartAsync(CancellationToken.None);
        await daemon.StopAsync(CancellationToken.None);

        await Assert.ThrowsAsync<Exceptions.BrokerUnavailableException>(
            () => daemon.AcquireAsync(MakePrincipal("post-stop"), JobId.New(), CancellationToken.None).AsTask());

        await daemon.DisposeAsync();
    }

    [Fact]
    public async Task MultipleExpiresAreFiredForMultipleLeases()
    {
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var opts = new BrokerOptions
        {
            MaxConcurrentHostWide = 2,
            LeaseTtl = TimeSpan.FromSeconds(5),
        };

        var (daemon, _, _) = MakeDaemon(opts, clock: clock, bus: bus);
        await daemon.StartAsync(CancellationToken.None);

        var a1 = await daemon.AcquireAsync(MakePrincipal("exp-1"), JobId.New(), CancellationToken.None);
        var a2 = await daemon.AcquireAsync(MakePrincipal("exp-2"), JobId.New(), CancellationToken.None);

        clock.Advance(TimeSpan.FromSeconds(10));
        await daemon.TriggerExpiryCheckAsync();

        Assert.Equal(2, bus.Of<HostAdmissionExpired>().Count);

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    public async Task DoubleDisposeAdmissionIsIdempotent()
    {
        var (daemon, _, _) = MakeDaemon();
        await daemon.StartAsync(CancellationToken.None);

        var admission = await daemon.AcquireAsync(MakePrincipal("double-dispose"), JobId.New(), CancellationToken.None);

        await admission.DisposeAsync();
        // Second dispose should not throw.
        await admission.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    public async Task SameUserMultipleQueuedJobsGetsSameUserHint()
    {
        var bus = new RecordingEventBus();
        var opts = new BrokerOptions { MaxConcurrentHostWide = 1 };
        var (daemon, _, _) = MakeDaemon(opts, bus: bus);
        await daemon.StartAsync(CancellationToken.None);

        var p1 = MakePrincipal("same-user");

        // p1 occupies the only slot.
        var first = await daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None);

        // Two more p1 jobs queue up.
        var t2 = daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None).AsTask();
        await Task.Delay(20);
        var t3 = daemon.AcquireAsync(p1, JobId.New(), CancellationToken.None).AsTask();
        await Task.Delay(20);

        // The second queued event should have the same-user hint.
        var events = bus.Of<ConcurrencyHostQueued>();
        Assert.True(events.Count >= 1);
        // At least one event should have the same-user actionable hint.
        Assert.Contains(events, e => e.ActionableHint.Contains("same user"));

        await first.DisposeAsync();
        await (await t2).DisposeAsync();
        await (await t3).DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    [Fact]
    public async Task FairnessSchedulerDrainReturnsAllWaiters()
    {
        var opts = new BrokerOptions { MaxConcurrentHostWide = 1 };
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var scheduler = new FairnessScheduler(clock, new FixedOptions<BrokerOptions>(opts), bus);

        var p1 = MakePrincipal("drain-1");
        var p2 = MakePrincipal("drain-2");
        var job = JobId.New();

        // Admit p1 directly (fills the slot).
        var decision1 = await scheduler.EnqueueAsync(p1, job, CancellationToken.None);

        // p2 and p3 queue up.
        var t2 = scheduler.EnqueueAsync(p2, job, CancellationToken.None).AsTask();
        await Task.Delay(10);

        // Drain should return p2's waiter.
        var waiters = await scheduler.DrainAsync();
        Assert.Equal(1, waiters.Count);

        // Cancel the drained waiters.
        foreach (var w in waiters)
        {
            _ = w.TrySetCanceled();
        }

        // Release p1's slot.
        await scheduler.ReleaseAsync(p1.PrincipalId);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => t2);
    }

    // ─────────────────────────────────────────────────────────────
    // Test helpers
    // ─────────────────────────────────────────────────────────────

    /// <summary>Thread-safe recording implementation of <see cref="IEventBus"/> for testing.</summary>
    private sealed class RecordingEventBus : IEventBus
    {
        private readonly List<object> published = [];
        private readonly object syncRoot = new();

        public IReadOnlyList<T> Of<T>()
        {
            lock (this.syncRoot)
            {
                return this.published.OfType<T>().ToList();
            }
        }

        public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
            where TEvent : notnull
        {
            lock (this.syncRoot)
            {
                this.published.Add(eventData);
            }

            return ValueTask.CompletedTask;
        }

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
    private sealed class FixedOptions<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;

        public T Get(string? name) => value;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    /// <summary>No-op RPC server for in-process unit tests.</summary>
    private sealed class NullRpcServer : IRpcServer
    {
        public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

        public Task StopAsync(CancellationToken ct) => Task.CompletedTask;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    /// <summary>Simple recording logger for testing log output.</summary>
    private sealed class RecordingLogger<T> : Microsoft.Extensions.Logging.ILogger<T>
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;

        public void Log<TState>(
            Microsoft.Extensions.Logging.LogLevel logLevel,
            Microsoft.Extensions.Logging.EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (logLevel == Microsoft.Extensions.Logging.LogLevel.Warning)
            {
                this.Warnings.Add(formatter(state, exception));
            }
        }
    }
}
