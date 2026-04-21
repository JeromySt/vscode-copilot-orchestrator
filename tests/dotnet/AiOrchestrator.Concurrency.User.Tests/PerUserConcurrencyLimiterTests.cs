// <copyright file="PerUserConcurrencyLimiterTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.User;
using AiOrchestrator.Concurrency.User.Events;
using AiOrchestrator.Concurrency.User.Exceptions;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Concurrency.User.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "CONC-USER-FIFO").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}

/// <summary>Acceptance tests for per-user FIFO concurrency limiter.</summary>
public sealed class PerUserConcurrencyLimiterTests
{
    private static AuthContext MakePrincipal(string id) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = ImmutableArray<string>.Empty,
    };

    private static PerUserConcurrencyLimiter MakeLimiter(
        UserConcurrencyOptions? options = null,
        RecordingEventBus? bus = null,
        InMemoryClock? clock = null)
    {
        var opts = options ?? new UserConcurrencyOptions();
        return new PerUserConcurrencyLimiter(
            clock ?? new InMemoryClock(),
            bus ?? new RecordingEventBus(),
            new FixedOptions<UserConcurrencyOptions>(opts));
    }

    [Fact]
    [ContractTest("CONC-USER-FIFO")]
    public async Task CONC_USER_FifoOrderingPreserved()
    {
        const int WaitersCount = 1000;
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1, FifoQueueDepth = WaitersCount + 10 };
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        await using var limiter = MakeLimiter(opts, bus, clock);

        var principal = MakePrincipal("fifo-user");
        var jobIds = Enumerable.Range(0, WaitersCount + 1).Select(_ => JobId.New()).ToArray();

        // Occupy the single slot
        var first = await limiter.AcquireAsync(principal, jobIds[0], CancellationToken.None);

        // Enqueue all waiters sequentially; each waiter runs synchronously until
        // it suspends on WaitTask (after adding itself to the queue), so queue order
        // matches enqueue order.
        var waitingTasks = new Task<UserAdmission>[WaitersCount];
        for (var i = 0; i < WaitersCount; i++)
        {
            clock.Advance(TimeSpan.FromMilliseconds(1)); // distinct timestamps
            waitingTasks[i] = limiter.AcquireAsync(principal, jobIds[i + 1], CancellationToken.None).AsTask();
        }

        // Release first slot and cascade: each disposal admits the next waiter
        var admissionOrder = new List<JobId>(WaitersCount);
        await first.DisposeAsync();

        for (var i = 0; i < WaitersCount; i++)
        {
            var admission = await waitingTasks[i];
            admissionOrder.Add(admission.JobId);
            await admission.DisposeAsync();
        }

        admissionOrder.Should().Equal(jobIds[1..], "admissions must be in FIFO order");
    }

    [Fact]
    [ContractTest("CONC-USER-QUEUED-1")]
    public async Task CONC_USER_QueuedEventEmittedExactlyOnce()
    {
        var bus = new RecordingEventBus();
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1 };
        await using var limiter = MakeLimiter(opts, bus);
        var principal = MakePrincipal("queued-user");
        var job1 = JobId.New();
        var job2 = JobId.New();

        // Fill the slot
        var first = await limiter.AcquireAsync(principal, job1, CancellationToken.None);

        // Enqueue a waiter — synchronously enters queue before Task suspends
        var waitingTask = limiter.AcquireAsync(principal, job2, CancellationToken.None).AsTask();

        bus.Of<ConcurrencyUserQueued>().Should().HaveCount(1, "ConcurrencyUserQueued must be emitted exactly once per queued request");
        bus.Of<ConcurrencyUserQueued>()[0].JobId.Should().Be(job2);
        bus.Of<ConcurrencyUserQueued>()[0].QueuePosition.Should().Be(0);

        await first.DisposeAsync();
        await using var second = await waitingTask;

        bus.Of<ConcurrencyUserQueued>().Should().HaveCount(1, "no additional Queued events after admission");
    }

    [Fact]
    [ContractTest("CONC-USER-ADM")]
    public async Task CONC_USER_AdmittedEventIncludesWaitTime()
    {
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1 };
        await using var limiter = MakeLimiter(opts, bus, clock);
        var principal = MakePrincipal("wait-user");
        var job1 = JobId.New();
        var job2 = JobId.New();

        var queuedAt = clock.UtcNow;

        // Occupy slot
        var first = await limiter.AcquireAsync(principal, job1, CancellationToken.None);

        // Enqueue waiter
        var waitingTask = limiter.AcquireAsync(principal, job2, CancellationToken.None).AsTask();

        // Advance clock to simulate wait
        var delay = TimeSpan.FromSeconds(3);
        clock.Advance(delay);

        // Release slot — waiter admitted at new time
        await first.DisposeAsync();
        await using var second = await waitingTask;

        var admittedEvents = bus.Of<ConcurrencyUserAdmitted>();
        admittedEvents.Should().Contain(e => e.JobId == job2, "ConcurrencyUserAdmitted must be published for the waiter");

        var admittedEvent = admittedEvents.Single(e => e.JobId == job2);
        admittedEvent.WaitTime.Should().BeGreaterThan(TimeSpan.Zero, "WaitTime must reflect actual queue wait");
        admittedEvent.WaitTime.Should().BeCloseTo(delay, TimeSpan.FromMilliseconds(50));
        admittedEvent.At.Should().Be(clock.UtcNow, "At must be the admission timestamp");
    }

    [Fact]
    [ContractTest("CONC-USER-OVERFLOW")]
    public async Task CONC_USER_QueueOverflowThrows()
    {
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1, FifoQueueDepth = 2 };
        await using var limiter = MakeLimiter(opts);
        var principal = MakePrincipal("overflow-user");

        // Occupy the slot
        var first = await limiter.AcquireAsync(principal, JobId.New(), CancellationToken.None);

        // Fill the queue to capacity
        var waiter1 = limiter.AcquireAsync(principal, JobId.New(), CancellationToken.None).AsTask();
        var waiter2 = limiter.AcquireAsync(principal, JobId.New(), CancellationToken.None).AsTask();

        // 3rd enqueue must throw
        var ex = await Assert.ThrowsAsync<UserConcurrencyQueueFullException>(() =>
            limiter.AcquireAsync(principal, JobId.New(), CancellationToken.None).AsTask());
        ex.QueueDepth.Should().Be(2);

        // Cleanup
        await first.DisposeAsync();
        await using var a1 = await waiter1;
        await a1.DisposeAsync();
        await using var a2 = await waiter2;
    }

    [Fact]
    [ContractTest("CONC-USER-RELEASE")]
    public async Task CONC_USER_DisposeReleasesSlot()
    {
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1 };
        await using var limiter = MakeLimiter(opts);
        var principal = MakePrincipal("release-user");
        var job1 = JobId.New();
        var job2 = JobId.New();

        // Acquire and release
        var first = await limiter.AcquireAsync(principal, job1, CancellationToken.None);
        await first.DisposeAsync();

        // After release, next acquire must be admitted immediately (no queuing)
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var second = await limiter.AcquireAsync(principal, job2, cts.Token);
        second.JobId.Should().Be(job2);
        second.AdmittedAt.Should().NotBe(default);
        await second.DisposeAsync();

        var activeCount = await limiter.GetActiveCountAsync(principal, CancellationToken.None);
        activeCount.Should().Be(0, "no active jobs after both admissions are disposed");
    }

    [Fact]
    [ContractTest("CONC-USER-CANCEL")]
    public async Task CONC_USER_CancellationRemovesWaiter()
    {
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1, FifoQueueDepth = 10 };
        var bus = new RecordingEventBus();
        await using var limiter = MakeLimiter(opts, bus);
        var principal = MakePrincipal("cancel-user");
        var jobA = JobId.New();
        var jobB = JobId.New();
        var jobC = JobId.New();

        // Occupy the slot
        var first = await limiter.AcquireAsync(principal, jobA, CancellationToken.None);

        // Enqueue B and C; then cancel B
        using var cts = new CancellationTokenSource();
        var waiterB = limiter.AcquireAsync(principal, jobB, cts.Token).AsTask();
        var waiterC = limiter.AcquireAsync(principal, jobC, CancellationToken.None).AsTask();

        // Cancel B's request
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiterB);

        // Release slot — C should be admitted (B was removed, FIFO order preserved for C)
        await first.DisposeAsync();
        await using var admittedC = await waiterC;
        admittedC.JobId.Should().Be(jobC, "C must be admitted after B was cancelled");
    }

    [Fact]
    [ContractTest("CONC-USER-ISO")]
    public async Task CONC_USER_PerUserIsolation()
    {
        var opts = new UserConcurrencyOptions { MaxConcurrentPerUser = 1 };
        await using var limiter = MakeLimiter(opts);
        var userA = MakePrincipal("user-A");
        var userB = MakePrincipal("user-B");

        // Fill userA's slot
        var aFirst = await limiter.AcquireAsync(userA, JobId.New(), CancellationToken.None);

        // userB's slot is independent — must admit immediately without queueing
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var bAdmission = await limiter.AcquireAsync(userB, JobId.New(), cts.Token);

        bAdmission.Principal.PrincipalId.Should().Be("user-B");

        // userA still blocked but userB can proceed
        var activeA = await limiter.GetActiveCountAsync(userA, CancellationToken.None);
        var activeB = await limiter.GetActiveCountAsync(userB, CancellationToken.None);
        activeA.Should().Be(1, "userA has 1 active job");
        activeB.Should().Be(1, "userB has 1 active job independently");

        await aFirst.DisposeAsync();
        await bAdmission.DisposeAsync();
    }

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

        public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
            where TEvent : notnull
        {
            lock (this.syncRoot)
            {
                this.published.Add(@event);
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
}
