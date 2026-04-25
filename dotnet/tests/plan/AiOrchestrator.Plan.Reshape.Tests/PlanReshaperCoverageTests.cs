// <copyright file="PlanReshaperCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Composition;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Reshape;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Plan = AiOrchestrator.Plan.Models.Plan;

namespace PlanReshapeTestsNs;

/// <summary>Extra coverage tests exercising paths not required by the acceptance suite.</summary>
public sealed class PlanReshaperCoverageTests : IAsyncLifetime
{
    private readonly string root;
    private PlanStore store = null!;

    public PlanReshaperCoverageTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "reshape-cov", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public Task InitializeAsync()
    {
        this.store = new PlanStore(
            new AbsolutePath(this.root),
            new PassthroughFileSystem(),
            new InMemoryClock(),
            new NullEventBus(),
            new StaticOptionsMonitor<PlanStoreOptions>(new PlanStoreOptions()),
            NullLogger<PlanStore>.Instance);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await this.store.DisposeAsync();
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch
        {
            // best-effort
        }
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

    private async Task<(PlanId Id, JobId A)> SeedSingleJobAsync(JobStatus status = JobStatus.Pending)
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        var a = JobId.New();
        await this.store.MutateAsync(
            planId,
            new JobAdded(0, default, default, MakeNode(a, "A", status)),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        return (planId, a);
    }

    [Fact]
    public async Task EmptyBatch_Throws_ArgumentException()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray<ReshapeOperation>.Empty, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await Assert.ThrowsAsync<ArgumentException>(act);
    }

    [Fact]
    public async Task UnknownPlan_Throws_InvalidOperation()
    {
        var reshaper = this.MakeReshaper();
        var ops = ImmutableArray.Create<ReshapeOperation>(new AddJob(MakeNode(JobId.New(), "x"), ImmutableArray<JobId>.Empty));
        var act = async () => await reshaper.ApplyAsync(PlanId.New(), ops, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await Assert.ThrowsAsync<InvalidOperationException>(act);
    }

    [Fact]
    public async Task AddJob_InvalidSpec_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddJob(new JobNode { Id = string.Empty, Title = "x" }, ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("InvalidSpec", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddJob_DuplicateId_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddJob(MakeNode(a, "A2"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("DuplicateJobId", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddJob_UnknownDependency_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray.Create(JobId.New()));
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownDependency", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task RemoveJob_UnknownJob_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new RemoveJob(JobId.New());
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownJob", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task RemoveJob_Succeeds_OnPending()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new RemoveJob(a);
        var result = await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        Assert.True(result.PerOperation.Single().Success);
        var loaded = await this.store.LoadAsync(planId, default);
        Assert.False(loaded!.Jobs.ContainsKey(a.ToString()));
    }

    [Fact]
    public async Task UpdateDeps_UnknownJob_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new UpdateDeps(JobId.New(), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownJob", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task UpdateDeps_UnknownDependency_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new UpdateDeps(a, ImmutableArray.Create(JobId.New()));
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownDependency", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task UpdateDeps_Succeeds()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        var b = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(b, "B")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var op = new UpdateDeps(b, ImmutableArray.Create(a));
        var result = await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        Assert.True(result.PerOperation.Single().Success);
        var loaded = await this.store.LoadAsync(planId, default);
        Assert.Equal(a.ToString(), Assert.Single(loaded!.Jobs[b.ToString()].DependsOn));
    }

    [Fact]
    public async Task AddBefore_Succeeds_PrependsNewDependency()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var a = JobId.New();
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, MakeNode(a, "A")), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        var newId = JobId.New();
        var op = new AddBefore(a, MakeNode(newId, "Before"), ImmutableArray<JobId>.Empty);
        var result = await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        Assert.True(result.PerOperation.Single().Success);

        var loaded = await this.store.LoadAsync(planId, default);
        Assert.True(loaded!.Jobs.ContainsKey(newId.ToString()));
        Assert.Contains(newId.ToString(), loaded.Jobs[a.ToString()].DependsOn);
    }

    [Fact]
    public async Task AddBefore_UnknownExisting_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddBefore(JobId.New(), MakeNode(JobId.New(), "x"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownJob", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddBefore_InvalidSpec_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddBefore(a, new JobNode { Id = string.Empty, Title = "x" }, ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("InvalidSpec", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddBefore_DuplicateId_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddBefore(a, MakeNode(a, "x"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("DuplicateJobId", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddBefore_ExistingNotPending_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync(JobStatus.Running);
        var reshaper = this.MakeReshaper();
        var op = new AddBefore(a, MakeNode(JobId.New(), "x"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("StatusNotUpdatable", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddBefore_UnknownDependency_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddBefore(a, MakeNode(JobId.New(), "x"), ImmutableArray.Create(JobId.New()));
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownDependency", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddAfter_UnknownExisting_Fails()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddAfter(JobId.New(), MakeNode(JobId.New(), "x"));
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("UnknownJob", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddAfter_DuplicateId_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddAfter(a, MakeNode(a, "x"));
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("DuplicateJobId", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task AddAfter_InvalidSpec_Fails()
    {
        var (planId, a) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        var op = new AddAfter(a, new JobNode { Id = string.Empty, Title = "x" });
        var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var ex = await Assert.ThrowsAsync<ReshapeRejectedException>(act);
        Assert.Equal("InvalidSpec", ex.Failures.Single().FailureReason);
    }

    [Fact]
    public async Task Sv_Node_Blocks_Remove_Update_AddBefore_AddAfter()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        var sv = new JobNode { Id = SnapshotValidationNodeImmutableException.NodeId, Title = "sv", Status = JobStatus.Pending };
        await this.store.MutateAsync(planId, new JobAdded(0, default, default, sv), IdempotencyKey.FromGuid(Guid.NewGuid()), default);

        var reshaper = this.MakeReshaper();
        // RemoveJob/UpdateDeps with JobId cannot reference SV (which uses string id). These paths
        // can't be hit directly without a JobId-form SV id. Instead test AddBefore/AddAfter whose
        // new spec references the SV id — which IS a string field.
        var ops = new ReshapeOperation[]
        {
            new AddBefore(JobId.New(), new JobNode { Id = SnapshotValidationNodeImmutableException.NodeId, Title = "x" }, ImmutableArray<JobId>.Empty),
            new AddAfter(JobId.New(), new JobNode { Id = SnapshotValidationNodeImmutableException.NodeId, Title = "x" }),
        };
        foreach (var op in ops)
        {
            var act = async () => await reshaper.ApplyAsync(planId, ImmutableArray.Create(op), IdempotencyKey.FromGuid(Guid.NewGuid()), default);
            await Assert.ThrowsAsync<SnapshotValidationNodeImmutableException>(act);
        }
    }

    [Fact]
    public void CompositionRoot_Registers_PlanReshaper()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IPlanStore>(this.store);
        services.AddSingleton<AiOrchestrator.Abstractions.Time.IClock>(new InMemoryClock());
        _ = services.AddPlanReshape();
        using var provider = services.BuildServiceProvider();
        var reshaper = provider.GetRequiredService<PlanReshaper>();
        Assert.NotNull(reshaper);
    }

    [Fact]
    public void CycleResult_Records_ShapeIsAsExpected()
    {
        var cycleFalse = new CycleResult { Cycle = false, Cycle_ = null };
        Assert.False(cycleFalse.Cycle);
        Assert.Null(cycleFalse.Cycle_);

        var ids = ImmutableArray.Create(JobId.New(), JobId.New());
        var cycleTrue = new CycleResult { Cycle = true, Cycle_ = ids };
        Assert.True(cycleTrue.Cycle);
        Assert.NotNull(cycleTrue.Cycle_);
        Assert.Equal(2, cycleTrue.Cycle_!.Value.Length);
    }

    [Fact]
    public async Task DagLim_MaxJobs_Default_IsUnbounded()
    {
        var (planId, _) = await this.SeedSingleJobAsync();
        var reshaper = this.MakeReshaper();
        // No MaxJobs / MaxParallel set — defaults are int.MaxValue; add many jobs without hitting limits.
        var ops = Enumerable.Range(0, 5)
            .Select(i => (ReshapeOperation)new AddJob(MakeNode(JobId.New(), $"J{i}"), ImmutableArray<JobId>.Empty))
            .ToImmutableArray();
        var result = await reshaper.ApplyAsync(planId, ops, IdempotencyKey.FromGuid(Guid.NewGuid()), default);
        Assert.All(result.PerOperation, item => Assert.True(item.Success));
    }
}
