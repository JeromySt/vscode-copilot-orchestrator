// <copyright file="ReshapeCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Reshape;
using AiOrchestrator.Plan.Reshape.Validation;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Plan = AiOrchestrator.Plan.Models.Plan;

namespace PlanReshapeTestsNs;

/// <summary>Coverage gap tests for PlanGraph, CycleGuard, and PlanReshaper edge cases.</summary>
public sealed class ReshapeCoverageGapTests : IAsyncLifetime
{
    private readonly string root;
    private PlanStore store = null!;

    public ReshapeCoverageGapTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "reshape-gap", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public Task InitializeAsync()
    {
        this.store = new PlanStore(
            new AbsolutePath(this.root),
            new NullFileSystem(),
            new InMemoryClock(),
            new NullEventBus(),
            new StaticOptionsMonitor<PlanStoreOptions>(new PlanStoreOptions()),
            NullLogger<PlanStore>.Instance);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await this.store.DisposeAsync();
        try { Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    private PlanReshaper MakeReshaper(PlanReshapeOptions? options = null) => new(
        this.store,
        new InMemoryClock(),
        new StaticOptionsMonitor<PlanReshapeOptions>(options ?? new PlanReshapeOptions()));

    private static JobNode MakeNode(JobId id, string title, JobStatus status = JobStatus.Pending, params JobId[] deps)
        => new()
        {
            Id = id.ToString(),
            Title = title,
            Status = status,
            DependsOn = deps.Select(d => d.ToString()).ToArray(),
        };

    // ── PlanGraph coverage ──

    [Fact]
    public void PlanGraph_From_NullPlan_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => PlanGraph.From(null!));
    }

    [Fact]
    public void PlanGraph_SuccessorsOf_ReturnsCorrectSuccessors()
    {
        var a = JobId.New();
        var b = JobId.New();
        var c = JobId.New();
        var plan = new Plan
        {
            Name = "p",
            Jobs = new Dictionary<string, JobNode>
            {
                [a.ToString()] = MakeNode(a, "A"),
                [b.ToString()] = MakeNode(b, "B", deps: a),
                [c.ToString()] = MakeNode(c, "C", deps: a),
            },
        };
        var graph = PlanGraph.From(plan);

        var successors = graph.SuccessorsOf(a.ToString()).ToList();
        Assert.Equal(2, successors.Count);
        Assert.Contains(b.ToString(), successors);
        Assert.Contains(c.ToString(), successors);
    }

    [Fact]
    public void PlanGraph_SuccessorsOf_NoSuccessors_ReturnsEmpty()
    {
        var a = JobId.New();
        var plan = new Plan
        {
            Name = "p",
            Jobs = new Dictionary<string, JobNode>
            {
                [a.ToString()] = MakeNode(a, "A"),
            },
        };
        var graph = PlanGraph.From(plan);

        Assert.Empty(graph.SuccessorsOf(a.ToString()));
    }

    [Fact]
    public void PlanGraph_WithJob_AddsOrReplaces()
    {
        var a = JobId.New();
        var plan = new Plan
        {
            Name = "p",
            Jobs = new Dictionary<string, JobNode>
            {
                [a.ToString()] = MakeNode(a, "A"),
            },
        };
        var graph = PlanGraph.From(plan);

        var b = JobId.New();
        var updated = graph.WithJob(MakeNode(b, "B"));
        Assert.Equal(2, updated.Jobs.Count);
        Assert.True(updated.Jobs.ContainsKey(b.ToString()));
    }

    [Fact]
    public void PlanGraph_WithJob_NullNode_Throws()
    {
        var plan = new Plan { Name = "p", Jobs = new Dictionary<string, JobNode>() };
        var graph = PlanGraph.From(plan);
        Assert.Throws<ArgumentNullException>(() => graph.WithJob(null!));
    }

    [Fact]
    public void PlanGraph_WithoutJob_RemovesAndCleansReferences()
    {
        var a = JobId.New();
        var b = JobId.New();
        var plan = new Plan
        {
            Name = "p",
            Jobs = new Dictionary<string, JobNode>
            {
                [a.ToString()] = MakeNode(a, "A"),
                [b.ToString()] = MakeNode(b, "B", deps: a),
            },
        };
        var graph = PlanGraph.From(plan);

        var updated = graph.WithoutJob(a.ToString());
        Assert.Single(updated.Jobs);
        Assert.DoesNotContain(a.ToString(), updated.Jobs[b.ToString()].DependsOn);
    }

    [Fact]
    public void PlanGraph_WithoutJob_NullJobId_Throws()
    {
        var plan = new Plan { Name = "p", Jobs = new Dictionary<string, JobNode>() };
        var graph = PlanGraph.From(plan);
        Assert.Throws<ArgumentNullException>(() => graph.WithoutJob(null!));
    }

    [Fact]
    public void PlanGraph_CountParallelRoots_CorrectCount()
    {
        var a = JobId.New();
        var b = JobId.New();
        var c = JobId.New();
        var plan = new Plan
        {
            Name = "p",
            Jobs = new Dictionary<string, JobNode>
            {
                [a.ToString()] = MakeNode(a, "A"),
                [b.ToString()] = MakeNode(b, "B"),
                [c.ToString()] = MakeNode(c, "C", deps: a),
            },
        };
        var graph = PlanGraph.From(plan);

        Assert.Equal(2, graph.CountParallelRoots());
    }

    // ── PlanReshaper: batch limit ──

    [Fact]
    public async Task BatchLimitExceeded_Throws()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper(new PlanReshapeOptions { MaxOpsPerCall = 1 });
        var ops = ImmutableArray.Create<ReshapeOperation>(
            new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray<JobId>.Empty),
            new AddJob(MakeNode(JobId.New(), "C"), ImmutableArray<JobId>.Empty));

        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ops, IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "BatchLimitExceeded");
    }

    // ── PlanReshaper: DAG limits (MaxJobs, MaxParallel) ──

    [Fact]
    public async Task MaxJobsExceeded_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper(new PlanReshapeOptions { MaxJobs = 1 });
        var op = new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray<JobId>.Empty);

        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason!.Contains("MaxJobs"));
    }

    [Fact]
    public async Task MaxParallelExceeded_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        // MaxParallel = 1 and we already have one root; adding another root should fail
        var reshaper = this.MakeReshaper(new PlanReshapeOptions { MaxParallel = 1 });
        var op = new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray<JobId>.Empty);

        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason!.Contains("MaxParallel"));
    }

    // ── PlanReshaper: RemoveJob status guard ──

    [Fact]
    public async Task RemoveJob_RunningStatus_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A", JobStatus.Running)), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var op = new RemoveJob(a);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "StatusNotRemovable");
    }

    // ── PlanReshaper: UpdateDeps status guard ──

    [Fact]
    public async Task UpdateDeps_RunningStatus_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A", JobStatus.Running)), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var op = new UpdateDeps(a, ImmutableArray<JobId>.Empty);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "StatusNotUpdatable");
    }

    // ── PlanReshaper: AddJob with null spec ──

    [Fact]
    public async Task AddJob_NullSpec_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var reshaper = this.MakeReshaper();
        var op = new AddJob(null!, ImmutableArray<JobId>.Empty);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "InvalidSpec");
    }

    // ── PlanReshaper: AddBefore with null spec ──

    [Fact]
    public async Task AddBefore_NullSpec_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var op = new AddBefore(a, null!, ImmutableArray<JobId>.Empty);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "InvalidSpec");
    }

    // ── PlanReshaper: AddAfter with null spec ──

    [Fact]
    public async Task AddAfter_NullSpec_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var op = new AddAfter(a, null!);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "InvalidSpec");
    }

    // ── PlanReshaper: AddBefore DAG limit ──

    [Fact]
    public async Task AddBefore_MaxJobs_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper(new PlanReshapeOptions { MaxJobs = 1 });
        var op = new AddBefore(a, MakeNode(JobId.New(), "Before"), ImmutableArray<JobId>.Empty);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason!.Contains("MaxJobs"));
    }

    // ── PlanReshaper: AddAfter DAG limit ──

    [Fact]
    public async Task AddAfter_MaxJobs_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper(new PlanReshapeOptions { MaxJobs = 1 });
        var op = new AddAfter(a, MakeNode(JobId.New(), "After"));
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason!.Contains("MaxJobs"));
    }

    // ── PlanReshaper: cycle detection in UpdateDeps ──

    [Fact]
    public async Task UpdateDeps_CreatesCycle_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        var b = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(b, "B", deps: a)), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        // A depends on B → cycle (A→B→A)
        var op = new UpdateDeps(a, ImmutableArray.Create(b));
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "Cycle");
    }

    // ── PlanReshaper: cycle detection in AddJob ──

    [Fact]
    public async Task AddJob_CreatesCycle_Fails()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        var b = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(b, "B", deps: a)), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        // Add C that depends on B, then make A depend on C → cycle
        var c = JobId.New();
        var node = MakeNode(c, "C", deps: b);
        // We can't create a cycle in a single AddJob since AddJob only adds forward edges.
        // Instead test via UpdateDeps creating the back-edge.
        // The cycle detection in AddJob is triggered when the new node's deps form a cycle.
        // Set up: A depends on nothing, C depends on A, add B that depends on C with A depending on B
        // Actually, just verify the cycle guard rejects properly structured cycles.
        var planId2 = await this.store.CreateAsync(new Plan { Name = "p2" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var x = JobId.New();
        var y = JobId.New();
        await this.store.MutateAsync(planId2, new JobAdded(0, default, default, new JobNode { Id = x.ToString(), Title = "X", DependsOn = [y.ToString()] }), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await this.store.MutateAsync(planId2, new JobAdded(0, default, default, MakeNode(y, "Y")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        // Adding Z that depends on X, then update X to depend on Z would be a cycle
        // But we can test AddJob with a dependency that goes back: add Z with dep on X while X depends on Y
        // Then update Y to depend on Z => cycle: Y→Z→X→Y
        var z = JobId.New();
        var addZ = new AddJob(MakeNode(z, "Z", deps: x), ImmutableArray.Create(x));
        var updateY = new UpdateDeps(y, ImmutableArray.Create(z));
        var ops = ImmutableArray.Create<ReshapeOperation>(addZ, updateY);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(
            () => reshaper.ApplyAsync(planId2, ops, IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
        Assert.Contains(ex.Failures, f => f.FailureReason == "Cycle");
    }

    // ── PlanReshaper: AddJob targeting SV node ──

    [Fact]
    public async Task AddJob_SvNodeId_ThrowsImmutable()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var reshaper = this.MakeReshaper();
        var svNode = new JobNode { Id = SnapshotValidationNodeImmutableException.NodeId, Title = "sv" };
        var op = new AddJob(svNode, ImmutableArray<JobId>.Empty);
        await Assert.ThrowsAsync<SnapshotValidationNodeImmutableException>(
            () => reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default).AsTask());
    }

    // ── Constructor guards ──

    [Fact]
    public void Constructor_NullStore_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new PlanReshaper(null!, new InMemoryClock(), new StaticOptionsMonitor<PlanReshapeOptions>(new PlanReshapeOptions())));
    }

    [Fact]
    public void Constructor_NullClock_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new PlanReshaper(this.store, null!, new StaticOptionsMonitor<PlanReshapeOptions>(new PlanReshapeOptions())));
    }

    [Fact]
    public void Constructor_NullOpts_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new PlanReshaper(this.store, new InMemoryClock(), null!));
    }
}
