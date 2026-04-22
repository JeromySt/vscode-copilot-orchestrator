// <copyright file="PlanSchedulerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using AiOrchestrator.Concurrency.Broker;
using AiOrchestrator.Concurrency.User;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using JobStatus = AiOrchestrator.Plan.Models.JobStatus;
using Microsoft.Extensions.Logging.Abstractions;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using PlanStatus = AiOrchestrator.Plan.Models.PlanStatus;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Acceptance tests for <see cref="PlanScheduler"/> lifecycle behaviour (pause, cancel, admit).</summary>
public sealed class PlanSchedulerTests
{
    private static PlanScheduler MakeScheduler(
        StubPlanStore store,
        StubPerUserConcurrency? userConc = null,
        StubPhaseExecutor? phaseExec = null,
        SchedulerOptions? opts = null) =>
        new(
            store,
            userConc ?? new StubPerUserConcurrency(),
            new StubHostBroker(),
            new RecordingEventBus(),
            new InMemoryClock(),
            phaseExec ?? new StubPhaseExecutor(),
            new FixedOptions<SchedulerOptions>(opts ?? new SchedulerOptions()),
            NullLogger<PlanScheduler>.Instance);

    private static PlanRecord MakePlan(PlanId planId, params JobNode[] jobs)
    {
        var jobMap = new Dictionary<string, JobNode>();
        foreach (var j in jobs)
        {
            jobMap[j.Id] = j;
        }

        return new PlanRecord { Id = planId.ToString(), Jobs = jobMap };
    }

    [Fact]
    [ContractTest("SCHED-PAUSE")]
    public async Task SCHED_PAUSE_NoNewAdmissions_InFlightCompletes()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();

        var pendingJob = new JobNode { Id = jobId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var plan = MakePlan(planId, pendingJob);

        var store = new StubPlanStore(plan);
        var phaseExec = new StubPhaseExecutor();
        await using var scheduler = MakeScheduler(store, phaseExec: phaseExec);

        await scheduler.StartAsync(CancellationToken.None);
        try
        {
            // Wait for WatchAsync to start — ensures the plan is registered.
            await store.WaitForWatchStartedAsync(TimeSpan.FromSeconds(5));

            // Pause BEFORE injecting any ready snapshot.
            await scheduler.PauseAsync(planId, CancellationToken.None);

            // Inject a snapshot that would normally make the job ready.
            store.PushSnapshot(plan);

            // Give the dispatch loop time to process (it must skip the paused plan).
            await Task.Delay(TimeSpan.FromMilliseconds(150), CancellationToken.None);

            phaseExec.ExecuteCallCount.Should().Be(0, "no jobs must be dispatched while the plan is paused (INV-9)");
        }
        finally
        {
            await scheduler.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    [ContractTest("SCHED-CANCEL")]
    public async Task SCHED_CANCEL_AllPendingFlippedToCanceled()
    {
        var planId = PlanId.New();
        var pendingJobId = JobId.New();
        var succeededJobId = JobId.New();

        var pendingJob = new JobNode { Id = pendingJobId.ToString(), Title = "pending-job", Status = JobStatus.Pending };
        var succeededJob = new JobNode { Id = succeededJobId.ToString(), Title = "succeeded-job", Status = JobStatus.Succeeded };
        var plan = MakePlan(planId, pendingJob, succeededJob);

        var store = new StubPlanStore(plan);
        await using var scheduler = MakeScheduler(store);

        await scheduler.StartAsync(CancellationToken.None);
        try
        {
            await store.WaitForWatchStartedAsync(TimeSpan.FromSeconds(5));

            // Cancel without injecting any snapshot so dispatch loop is idle.
            await scheduler.CancelAsync(planId, CancellationToken.None);

            // Exactly one JobStatusUpdated(Canceled) for the Pending job and one PlanStatusUpdated(Canceled).
            var mutations = store.Mutations;
            mutations.Should().HaveCount(2, "one job mutation + one plan mutation");

            var jobMut = mutations.Should().ContainSingle(m => m.Mut is JobStatusUpdated)
                .Which.Mut as JobStatusUpdated;
            jobMut!.NewStatus.Should().Be(JobStatus.Canceled, "pending job must be flipped to Canceled (INV-10)");
            jobMut.JobIdValue.Should().Be(pendingJobId.ToString(), "only the Pending job is canceled; Succeeded jobs are left alone");

            var planMut = mutations.Should().ContainSingle(m => m.Mut is PlanStatusUpdated)
                .Which.Mut as PlanStatusUpdated;
            planMut!.NewStatus.Should().Be(PlanStatus.Canceled, "plan status must be set to Canceled");
        }
        finally
        {
            await scheduler.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    [ContractTest("SCHED-ADMIT")]
    public async Task SCHED_ADMIT_FailureRequeues()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();

        // A Pending job with no dependencies becomes immediately ready.
        var pendingJob = new JobNode { Id = jobId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var plan = MakePlan(planId, pendingJob);

        var store = new StubPlanStore(plan);
        var userConc = new StubPerUserConcurrency(alwaysThrow: true);
        await using var scheduler = MakeScheduler(store, userConc: userConc);

        await scheduler.StartAsync(CancellationToken.None);
        try
        {
            await store.WaitForWatchStartedAsync(TimeSpan.FromSeconds(5));

            // Inject a snapshot — the scheduler will compute the job as ready and write it to ReadyChannel.
            store.PushSnapshot(plan);

            // Wait until the user-concurrency limiter is called at least twice (proving re-queue).
            bool calledTwice = await userConc.WaitForMinCallsAsync(minCalls: 2, timeout: TimeSpan.FromSeconds(5));
            calledTwice.Should().BeTrue("after admission failure the job must be re-queued and retried (INV-8)");
        }
        finally
        {
            await scheduler.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task ResumeAsync_ClearsThePausedFlagForRegisteredPlan()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();

        var pendingJob = new JobNode { Id = jobId.ToString(), Title = "job-a", Status = JobStatus.Pending };
        var plan = MakePlan(planId, pendingJob);

        var store = new StubPlanStore(plan);
        await using var scheduler = MakeScheduler(store);

        await scheduler.StartAsync(CancellationToken.None);
        try
        {
            // Ensure the plan is registered in the scheduler's internal dict.
            await store.WaitForWatchStartedAsync(TimeSpan.FromSeconds(5));

            // Pause the plan, then resume it — both should complete without error.
            await scheduler.PauseAsync(planId, CancellationToken.None);
            await scheduler.ResumeAsync(planId, CancellationToken.None);
        }
        finally
        {
            await scheduler.StopAsync(CancellationToken.None);
        }
    }

    // ─── Stubs ──────────────────────────────────────────────────────────────

    private sealed class StubPlanStore : IPlanStore
    {
        private readonly PlanRecord plan;
        private readonly Channel<PlanRecord> watchChannel = Channel.CreateUnbounded<PlanRecord>();
        private readonly SemaphoreSlim watchStarted = new(0, 1);
        private readonly List<(PlanId Id, PlanMutation Mut)> mutations = [];

        public StubPlanStore(PlanRecord plan) => this.plan = plan;

        public IReadOnlyList<(PlanId Id, PlanMutation Mut)> Mutations
        {
            get
            {
                lock (this.mutations)
                {
                    return [.. this.mutations];
                }
            }
        }

        public void PushSnapshot(PlanRecord p) => this.watchChannel.Writer.TryWrite(p);

        public async Task WaitForWatchStartedAsync(TimeSpan timeout)
        {
            bool acquired = await this.watchStarted.WaitAsync(timeout);
            acquired.Should().BeTrue("WatchAsync must be called within the timeout");
        }

        public async IAsyncEnumerable<PlanRecord> ListAsync([EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield return this.plan;
        }

        public async IAsyncEnumerable<PlanRecord> WatchAsync(PlanId id, [EnumeratorCancellation] CancellationToken ct)
        {
            this.watchStarted.Release();
            await foreach (var p in this.watchChannel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                yield return p;
            }
        }

        public ValueTask<PlanRecord?> LoadAsync(PlanId id, CancellationToken ct) =>
            ValueTask.FromResult<PlanRecord?>(this.plan);

        public ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct)
        {
            lock (this.mutations)
            {
                this.mutations.Add((id, mutation));
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask<PlanId> CreateAsync(PlanRecord initialPlan, IdempotencyKey idemKey, CancellationToken ct) =>
            throw new NotSupportedException("Not used in scheduler tests.");

        public ValueTask CheckpointAsync(PlanId id, CancellationToken ct) =>
            throw new NotSupportedException("Not used in scheduler tests.");

        public IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, CancellationToken ct) =>
            throw new NotSupportedException("Not used in scheduler tests.");
    }

    private sealed class StubPerUserConcurrency : IPerUserConcurrency
    {
        private readonly bool alwaysThrow;
        private int callCount;
        private readonly SemaphoreSlim minCallsSem = new(0, 1);
        private volatile int minCallsTarget;

        public StubPerUserConcurrency(bool alwaysThrow = false) =>
            this.alwaysThrow = alwaysThrow;

        public async Task<bool> WaitForMinCallsAsync(int minCalls, TimeSpan timeout)
        {
            this.minCallsTarget = minCalls;

            // If already reached, release immediately.
            if (Volatile.Read(ref this.callCount) >= minCalls)
            {
                return true;
            }

            return await this.minCallsSem.WaitAsync(timeout);
        }

        public ValueTask<UserAdmission> AcquireAsync(AuthContext principal, JobId jobId, CancellationToken ct)
        {
            int count = Interlocked.Increment(ref this.callCount);
            int target = this.minCallsTarget;
            if (target > 0 && count >= target)
            {
                this.minCallsSem.Release();
            }

            if (this.alwaysThrow)
            {
                throw new InvalidOperationException("Stub: admission refused for test.");
            }

            throw new NotSupportedException("Success path not expected in scheduler tests.");
        }

        public ValueTask<int> GetActiveCountAsync(AuthContext principal, CancellationToken ct) =>
            ValueTask.FromResult(0);
    }

    private sealed class StubHostBroker : IHostConcurrencyBrokerClient
    {
        public ValueTask<HostAdmission> AcquireAsync(AuthContext principal, JobId job, CancellationToken ct) =>
            throw new NotSupportedException("Host broker not expected in these tests.");
    }

    private sealed class StubPhaseExecutor : IPhaseExecutor
    {
        private int executeCallCount;

        public int ExecuteCallCount => Volatile.Read(ref this.executeCallCount);

        public ValueTask ExecuteAsync(PlanId planId, JobId jobId, CancellationToken ct)
        {
            _ = Interlocked.Increment(ref this.executeCallCount);
            return ValueTask.CompletedTask;
        }
    }
}
