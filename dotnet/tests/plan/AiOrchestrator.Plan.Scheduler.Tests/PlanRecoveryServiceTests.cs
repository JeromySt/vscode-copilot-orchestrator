// <copyright file="PlanRecoveryServiceTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Recovery;
using AiOrchestrator.Plan.Store;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;
using Xunit;

namespace AiOrchestrator.Plan.Scheduler.Tests;

/// <summary>Unit tests for <see cref="PlanRecoveryService"/>.</summary>
public sealed class PlanRecoveryServiceTests
{
    [Fact]
    public async Task RecoverAsync_ResetsFailedCanceledBlockedJobs_ToPending()
    {
        var planId = PlanId.New();
        var failedJob = new JobNode { Id = JobId.New().ToString(), Title = "failed", Status = JobStatus.Failed };
        var canceledJob = new JobNode { Id = JobId.New().ToString(), Title = "canceled", Status = JobStatus.Canceled };
        var blockedJob = new JobNode { Id = JobId.New().ToString(), Title = "blocked", Status = JobStatus.Blocked };
        var succeededJob = new JobNode { Id = JobId.New().ToString(), Title = "succeeded", Status = JobStatus.Succeeded };

        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Status = PlanStatus.Failed,
            Jobs = new Dictionary<string, JobNode>
            {
                [failedJob.Id] = failedJob,
                [canceledJob.Id] = canceledJob,
                [blockedJob.Id] = blockedJob,
                [succeededJob.Id] = succeededJob,
            },
        };

        var store = new RecoveryStubStore(plan);
        var svc = new PlanRecoveryService(store);

        var result = await svc.RecoverAsync(planId);

        Assert.Equal(3, result.JobsReset);
        Assert.Equal(planId, result.PlanId);

        // 3 job resets + 1 plan status update = 4 mutations
        Assert.Equal(4, store.Mutations.Count);

        var jobMutations = store.Mutations
            .Where(m => m.Mut is JobStatusUpdated)
            .Select(m => (JobStatusUpdated)m.Mut)
            .ToList();
        Assert.All(jobMutations, m => Assert.Equal(JobStatus.Pending, m.NewStatus));

        var planMutation = store.Mutations
            .Where(m => m.Mut is PlanStatusUpdated)
            .Select(m => (PlanStatusUpdated)m.Mut)
            .Single();
        Assert.Equal(PlanStatus.Paused, planMutation.NewStatus);
    }

    [Fact]
    public async Task RecoverAsync_PlanNotFound_Throws()
    {
        var store = new RecoveryStubStore(null);
        var svc = new PlanRecoveryService(store);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => svc.RecoverAsync(PlanId.New()));
    }

    [Fact]
    public async Task RecoverAsync_RunningPlan_Throws()
    {
        var planId = PlanId.New();
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Status = PlanStatus.Running,
            Jobs = new Dictionary<string, JobNode>(),
        };

        var store = new RecoveryStubStore(plan);
        var svc = new PlanRecoveryService(store);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => svc.RecoverAsync(planId));
    }

    [Fact]
    public async Task RecoverAsync_CanceledPlan_Recovers()
    {
        var planId = PlanId.New();
        var job = new JobNode { Id = JobId.New().ToString(), Title = "canceled", Status = JobStatus.Canceled };
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Status = PlanStatus.Canceled,
            Jobs = new Dictionary<string, JobNode> { [job.Id] = job },
        };

        var store = new RecoveryStubStore(plan);
        var svc = new PlanRecoveryService(store);

        var result = await svc.RecoverAsync(planId);

        Assert.Equal(1, result.JobsReset);
    }

    [Fact]
    public async Task RecoverAsync_PartialPlan_Recovers()
    {
        var planId = PlanId.New();
        var blocked = new JobNode { Id = JobId.New().ToString(), Title = "blocked", Status = JobStatus.Blocked };
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Status = PlanStatus.Partial,
            Jobs = new Dictionary<string, JobNode> { [blocked.Id] = blocked },
        };

        var store = new RecoveryStubStore(plan);
        var svc = new PlanRecoveryService(store);

        var result = await svc.RecoverAsync(planId);

        Assert.Equal(1, result.JobsReset);
    }

    [Fact]
    public async Task RecoverAsync_AllSucceeded_ResetsZeroJobs()
    {
        var planId = PlanId.New();
        var ok = new JobNode { Id = JobId.New().ToString(), Title = "ok", Status = JobStatus.Succeeded };
        var plan = new PlanRecord
        {
            Id = planId.ToString(),
            Status = PlanStatus.Failed,
            Jobs = new Dictionary<string, JobNode> { [ok.Id] = ok },
        };

        var store = new RecoveryStubStore(plan);
        var svc = new PlanRecoveryService(store);

        var result = await svc.RecoverAsync(planId);

        Assert.Equal(0, result.JobsReset);
        // Plan status mutation still happens.
        Assert.Single(store.Mutations.Where(m => m.Mut is PlanStatusUpdated));
    }

    [Fact]
    public void Ctor_NullStore_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new PlanRecoveryService(null!));
    }

    // ─── Stub ────────────────────────────────────────────────────────────────

    private sealed class RecoveryStubStore : IPlanStore
    {
        private readonly PlanRecord? plan;

        public RecoveryStubStore(PlanRecord? plan) => this.plan = plan;

        public List<(PlanId Id, PlanMutation Mut)> Mutations { get; } = new();

        public ValueTask<PlanRecord?> LoadAsync(PlanId id, CancellationToken ct) =>
            ValueTask.FromResult(this.plan);

        public ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct)
        {
            this.Mutations.Add((id, mutation));
            return ValueTask.CompletedTask;
        }

        public async IAsyncEnumerable<PlanRecord> ListAsync([EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield break;
        }

        public IAsyncEnumerable<PlanRecord> WatchAsync(PlanId id, CancellationToken ct) =>
            throw new NotSupportedException();

        public ValueTask<PlanId> CreateAsync(PlanRecord initialPlan, IdempotencyKey idemKey, CancellationToken ct) =>
            throw new NotSupportedException();

        public ValueTask CheckpointAsync(PlanId id, CancellationToken ct) =>
            throw new NotSupportedException();

        public IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
