// <copyright file="SchedulerCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Channels;
using AiOrchestrator.Plan.Scheduler.Completion;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Scheduler.Ready;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using JobNode = AiOrchestrator.Plan.Models.JobNode;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Targeted coverage-gap tests for Scheduler assembly (~7 lines).</summary>
public sealed class SchedulerCoverageGapTests
{
    // ================================================================
    // PlanCompletionHandler — null plan, all-failed terminal
    // ================================================================

    [Fact]
    public async System.Threading.Tasks.Task CompletionHandler_NullPlan_ReturnsFalse()
    {
        var store = new NullPlanStore();
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var handler = new PlanCompletionHandler(store, bus, clock, NullLogger<PlanCompletionHandler>.Instance);

        var result = await handler.ProcessAsync(PlanId.New(), System.Threading.CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async System.Threading.Tasks.Task CompletionHandler_AllFailed_DerivesPlanFailed()
    {
        var planId = PlanId.New();
        var jobA = new JobNode { Id = JobId.New().ToString(), Title = "a", Status = JobStatus.Failed };
        var jobB = new JobNode { Id = JobId.New().ToString(), Title = "b", Status = JobStatus.Failed };
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobA.Id] = jobA, [jobB.Id] = jobB },
        };
        var store = new InMemoryPlanStore(plan);
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var handler = new PlanCompletionHandler(store, bus, clock, NullLogger<PlanCompletionHandler>.Instance);

        var result = await handler.ProcessAsync(planId, System.Threading.CancellationToken.None);

        Assert.True(result);
        var planMut = Assert.Single(store.Mutations, m => m.Mut is PlanStatusUpdated);
        Assert.Equal(PlanStatus.Failed, ((PlanStatusUpdated)planMut.Mut).NewStatus);
    }

    [Fact]
    public async System.Threading.Tasks.Task CompletionHandler_NotAllTerminal_ReturnsFalse()
    {
        var planId = PlanId.New();
        var jobA = new JobNode { Id = JobId.New().ToString(), Title = "a", Status = JobStatus.Succeeded };
        var jobB = new JobNode { Id = JobId.New().ToString(), Title = "b", Status = JobStatus.Running };
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobA.Id] = jobA, [jobB.Id] = jobB },
        };
        var store = new InMemoryPlanStore(plan);
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var handler = new PlanCompletionHandler(store, bus, clock, NullLogger<PlanCompletionHandler>.Instance);

        var result = await handler.ProcessAsync(planId, System.Threading.CancellationToken.None);

        Assert.False(result);
    }

    // ================================================================
    // ReadySet — Skipped predecessors treated as succeeded
    // ================================================================

    [Fact]
    public void ReadySet_SkippedPredecessor_MakesJobReady()
    {
        var jobAId = JobId.New();
        var jobBId = JobId.New();
        var jobA = new JobNode { Id = jobAId.ToString(), Title = "a", Status = JobStatus.Skipped };
        var jobB = new JobNode
        {
            Id = jobBId.ToString(),
            Title = "b",
            Status = JobStatus.Pending,
            DependsOn = [jobAId.ToString()],
        };
        var plan = new PlanRecord
        {
            Id = PlanId.New().ToString(),
            Jobs = new Dictionary<string, JobNode> { [jobA.Id] = jobA, [jobB.Id] = jobB },
        };
        var graph = new PlanGraph(plan);
        var readySet = new ReadySet(graph);
        var statuses = new Dictionary<JobId, JobStatus>
        {
            [jobAId] = JobStatus.Skipped,
            [jobBId] = JobStatus.Pending,
        };

        var ready = readySet.ComputeReady(statuses);

        Assert.Single(ready);
        Assert.Equal(jobBId, ready[0]);
    }

    // ================================================================
    // SchedulingChannels — dedup disabled always passes
    // ================================================================

    [Fact]
    public void SchedulingChannels_DedupDisabled_SameKeyPasses()
    {
        var opts = new SchedulerOptions { EnableEventDedup = false };
        var channels = new SchedulingChannels(new FixedOptions<SchedulerOptions>(opts));
        var planId = PlanId.New();
        var jobId = JobId.New();

        Assert.True(channels.TryDedup(planId, jobId, "ready", 1000));
        Assert.True(channels.TryDedup(planId, jobId, "ready", 1001));
        channels.Complete();
    }

    // ================================================================
    // JobReadyEvent — property coverage
    // ================================================================

    [Fact]
    public void JobReadyEvent_Properties_Roundtrip()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var predId = JobId.New();
        var at = DateTimeOffset.UtcNow;

        var evt = new JobReadyEvent
        {
            PlanId = planId,
            JobId = jobId,
            Predecessors = ImmutableArray.Create(predId),
            At = at,
        };

        Assert.Equal(planId, evt.PlanId);
        Assert.Equal(jobId, evt.JobId);
        Assert.Single(evt.Predecessors);
        Assert.Equal(predId, evt.Predecessors[0]);
        Assert.Equal(at, evt.At);
    }

    // ================================================================
    // Stubs
    // ================================================================

    private sealed class NullPlanStore : AiOrchestrator.Plan.Store.IPlanStore
    {
        public System.Threading.Tasks.ValueTask<PlanRecord?> LoadAsync(PlanId id, System.Threading.CancellationToken ct) =>
            System.Threading.Tasks.ValueTask.FromResult<PlanRecord?>(null);

        public System.Threading.Tasks.ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public System.Threading.Tasks.ValueTask<PlanId> CreateAsync(PlanRecord initialPlan, IdempotencyKey idemKey, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public System.Threading.Tasks.ValueTask CheckpointAsync(PlanId id, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanRecord> ListAsync(System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanRecord> WatchAsync(PlanId id, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private sealed class InMemoryPlanStore : AiOrchestrator.Plan.Store.IPlanStore
    {
        private readonly PlanRecord plan;
        private readonly List<(PlanId Id, PlanMutation Mut)> mutations = [];

        public InMemoryPlanStore(PlanRecord plan) => this.plan = plan;

        public IReadOnlyList<(PlanId Id, PlanMutation Mut)> Mutations
        {
            get
            {
                lock (this.mutations) { return [.. this.mutations]; }
            }
        }

        public System.Threading.Tasks.ValueTask<PlanRecord?> LoadAsync(PlanId id, System.Threading.CancellationToken ct) =>
            System.Threading.Tasks.ValueTask.FromResult<PlanRecord?>(this.plan);

        public System.Threading.Tasks.ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, System.Threading.CancellationToken ct)
        {
            lock (this.mutations) { this.mutations.Add((id, mutation)); }
            return System.Threading.Tasks.ValueTask.CompletedTask;
        }

        public System.Threading.Tasks.ValueTask<PlanId> CreateAsync(PlanRecord initialPlan, IdempotencyKey idemKey, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public System.Threading.Tasks.ValueTask CheckpointAsync(PlanId id, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanRecord> ListAsync(System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanRecord> WatchAsync(PlanId id, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, System.Threading.CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
