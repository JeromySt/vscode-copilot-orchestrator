// <copyright file="PlanReshaperContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Reshape;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Plan = AiOrchestrator.Plan.Models.Plan;

namespace PlanReshapeTestsNs;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class PlanReshaperContractTests : IAsyncLifetime
{
    private readonly string root;
    private PlanStore store = null!;

    public PlanReshaperContractTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "reshape-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public Task InitializeAsync()
    {
        this.store = this.CreateStore();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await this.store.DisposeAsync();
        try
        {
            if (Directory.Exists(this.root))
            {
                Directory.Delete(this.root, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    // --------------- helpers ---------------

    private PlanStore CreateStore(PlanStoreOptions? options = null)
    {
        var clock = new InMemoryClock();
        var fs = new NullFileSystem();
        var bus = new NullEventBus();
        var opts = new StaticOptionsMonitor<PlanStoreOptions>(options ?? new PlanStoreOptions());
        return new PlanStore(new AbsolutePath(this.root), fs, clock, bus, opts, NullLogger<PlanStore>.Instance);
    }

    private static PlanReshaper CreateReshaper(IPlanStore store, PlanReshapeOptions? options = null)
    {
        var clock = new InMemoryClock();
        var opts = new StaticOptionsMonitor<PlanReshapeOptions>(options ?? new PlanReshapeOptions());
        return new PlanReshaper(store, clock, opts);
    }

    private static JobNode MakeNode(JobId id, string title, JobStatus status = JobStatus.Pending, IEnumerable<JobId>? deps = null)
        => new()
        {
            Id = id.ToString(),
            Title = title,
            Status = status,
            DependsOn = (deps ?? Array.Empty<JobId>()).Select(d => d.ToString()).ToArray(),
        };

    private async Task<(PlanId PlanId, Dictionary<string, JobId> Ids)> SeedPlanAsync(
        params (string Title, JobStatus Status, string[] DependsOn)[] jobs)
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        var ids = new Dictionary<string, JobId>(StringComparer.Ordinal);
        foreach (var (title, _, _) in jobs)
        {
            ids[title] = JobId.New();
        }

        foreach (var (title, status, deps) in jobs)
        {
            var node = MakeNode(ids[title], title, status, deps.Select(d => ids[d]));
            await this.store.MutateAsync(planId, new JobAdded(0, default, default, node), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        }

        return (planId, ids);
    }

    private async Task<int> CountJournalAsync(PlanId planId)
    {
        int n = 0;
        await foreach (var _ in this.store.ReadJournalAsync(planId, 0, CancellationToken.None))
        {
            n++;
        }

        return n;
    }

    // --------------- acceptance tests ---------------

    [Fact]
    [ContractTest("RS-TXN-1")]
    public async Task RS_TXN_1_BatchAtomicValidation()
    {
        var (planId, ids) = await this.SeedPlanAsync(("A", JobStatus.Pending, Array.Empty<string>()));
        var reshaper = CreateReshaper(this.store);
        var journalBefore = await this.CountJournalAsync(planId);

        var goodOp = new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray.Create(ids["A"]));
        var badOp = new RemoveJob(JobId.New()); // references a job not in the plan

        var ops = ImmutableArray.Create<ReshapeOperation>(goodOp, badOp);

        var act = async () => await reshaper.ApplyAsync(planId, ops, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().Contain(f => f.FailureReason == "UnknownJob");

        // RS-TXN-1 atomicity: nothing was persisted.
        (await this.CountJournalAsync(planId)).Should().Be(journalBefore);
        var loaded = await this.store.LoadAsync(planId, CancellationToken.None);
        loaded!.Jobs.Values.Should().NotContain(j => j.Title == "B");
    }

    [Fact]
    [ContractTest("RS-TXN-2")]
    public async Task RS_TXN_2_BatchUsesSingleIdempotencyKey()
    {
        var (planId, ids) = await this.SeedPlanAsync(("A", JobStatus.Pending, Array.Empty<string>()));
        var reshaper = CreateReshaper(this.store);

        var idem = IdempotencyKey.FromGuid(Guid.NewGuid());
        var ops = ImmutableArray.Create<ReshapeOperation>(
            new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray.Create(ids["A"])),
            new AddJob(MakeNode(JobId.New(), "C"), ImmutableArray.Create(ids["A"])));

        var result = await reshaper.ApplyAsync(planId, ops, idem, CancellationToken.None);
        result.PerOperation.Should().HaveCount(2).And.OnlyContain(r => r.Success);

        // Each of the two mutations should use a DISTINCT derived sub-key (RS-TXN-2 semantics:
        // a single caller key deterministically expands into per-mutation sub-keys).
        var mutations = new List<PlanMutation>();
        await foreach (var m in this.store.ReadJournalAsync(planId, 0, CancellationToken.None))
        {
            mutations.Add(m);
        }

        var reshapeMutations = mutations.Where(m => m is JobAdded ja && (ja.Node.Title == "B" || ja.Node.Title == "C")).ToArray();
        reshapeMutations.Select(m => m.IdemKey).Distinct().Should().HaveCount(2, "each op gets its own sub-key");

        // Retry is atomic: a second call either succeeds (idempotent replay) or throws
        // ReshapeRejectedException, but in both cases the journal MUST NOT grow.
        var journalBefore = mutations.Count;
        try
        {
            await reshaper.ApplyAsync(planId, ops, idem, CancellationToken.None);
        }
        catch (ReshapeRejectedException)
        {
            // RS-TXN-1 enforces atomicity on validation failure — which is acceptable
            // since B/C already exist in the plan after the first apply.
        }

        (await this.CountJournalAsync(planId)).Should().Be(journalBefore, "retry with same idem key must not create duplicate mutations");
    }

    [Fact]
    [ContractTest("RS-AFTER-1")]
    public async Task RS_AFTER_1_RewiresSuccessors()
    {
        // Graph:  A → B, A → C
        var (planId, ids) = await this.SeedPlanAsync(
            ("A", JobStatus.Pending, Array.Empty<string>()),
            ("B", JobStatus.Pending, new[] { "A" }),
            ("C", JobStatus.Pending, new[] { "A" }));

        var reshaper = CreateReshaper(this.store);
        var newId = JobId.New();
        var newNode = MakeNode(newId, "N");
        var op = new AddAfter(ids["A"], newNode);

        await reshaper.ApplyAsync(planId, ImmutableArray.Create<ReshapeOperation>(op), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var loaded = await this.store.LoadAsync(planId, CancellationToken.None);
        loaded!.Jobs.Should().ContainKey(newId.ToString());
        loaded.Jobs[newId.ToString()].DependsOn.Should().ContainSingle().Which.Should().Be(ids["A"].ToString());
        loaded.Jobs[ids["B"].ToString()].DependsOn.Should().ContainSingle().Which.Should().Be(newId.ToString());
        loaded.Jobs[ids["C"].ToString()].DependsOn.Should().ContainSingle().Which.Should().Be(newId.ToString());
    }

    [Fact]
    [ContractTest("RS-AFTER-2")]
    public async Task RS_AFTER_2_CycleDetectedBeforeApply()
    {
        // Graph: A, B where B depends on A. UpdateDeps(A → [B]) creates cycle A↔B.
        var (planId, ids) = await this.SeedPlanAsync(
            ("A", JobStatus.Pending, Array.Empty<string>()),
            ("B", JobStatus.Pending, new[] { "A" }));

        var reshaper = CreateReshaper(this.store);
        var op = new UpdateDeps(ids["A"], ImmutableArray.Create(ids["B"]));
        var journalBefore = await this.CountJournalAsync(planId);

        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle().Which.FailureReason.Should().Be("Cycle");

        // Cycle detected BEFORE any mutation landed.
        (await this.CountJournalAsync(planId)).Should().Be(journalBefore);
        var loaded = await this.store.LoadAsync(planId, CancellationToken.None);
        loaded!.Jobs[ids["A"].ToString()].DependsOn.Should().BeEmpty();
    }

    [Fact]
    [ContractTest("DAG-LIM-1")]
    public async Task DAG_LIM_1_MaxJobsCheckedAtReshape()
    {
        var (planId, _) = await this.SeedPlanAsync(
            ("A", JobStatus.Pending, Array.Empty<string>()),
            ("B", JobStatus.Pending, Array.Empty<string>()));

        var reshaper = CreateReshaper(this.store, new PlanReshapeOptions { MaxJobs = 2 });

        var op = new AddJob(MakeNode(JobId.New(), "C"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle()
            .Which.FailureReason.Should().Be("DagLimitExceeded:MaxJobs");
    }

    [Fact]
    [ContractTest("DAG-LIM-1-PAR")]
    public async Task DAG_LIM_1_MaxParallelCheckedAtReshape()
    {
        var (planId, _) = await this.SeedPlanAsync(
            ("A", JobStatus.Pending, Array.Empty<string>()),
            ("B", JobStatus.Pending, Array.Empty<string>()));

        var reshaper = CreateReshaper(this.store, new PlanReshapeOptions { MaxParallel = 2 });

        var op = new AddJob(MakeNode(JobId.New(), "C"), ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle()
            .Which.FailureReason.Should().Be("DagLimitExceeded:MaxParallel");
    }

    [Fact]
    [ContractTest("RS-REMOVE")]
    public async Task RS_REMOVE_RunningJobRejected()
    {
        var (planId, ids) = await this.SeedPlanAsync(("A", JobStatus.Running, Array.Empty<string>()));

        var reshaper = CreateReshaper(this.store);
        var op = new RemoveJob(ids["A"]);
        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle().Which.FailureReason.Should().Be("StatusNotRemovable");
    }

    [Fact]
    [ContractTest("RS-DEPS")]
    public async Task RS_UPDATE_DEPS_RunningJobRejected()
    {
        var (planId, ids) = await this.SeedPlanAsync(
            ("A", JobStatus.Pending, Array.Empty<string>()),
            ("B", JobStatus.Running, Array.Empty<string>()));

        var reshaper = CreateReshaper(this.store);
        var op = new UpdateDeps(ids["B"], ImmutableArray.Create(ids["A"]));
        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle().Which.FailureReason.Should().Be("StatusNotUpdatable");
    }

    [Fact]
    [ContractTest("RS-SV")]
    public async Task RS_SV_NODE_Immutable()
    {
        var planId = await this.store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        var reshaper = CreateReshaper(this.store);

        // Attempts to ADD a node with the snapshot-validation id must throw.
        var op = new AddJob(
            new JobNode { Id = SnapshotValidationNodeImmutableException.NodeId, Title = "sv" },
            ImmutableArray<JobId>.Empty);
        var act = async () => await reshaper.ApplyAsync(
            planId,
            ImmutableArray.Create<ReshapeOperation>(op),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await act.Should().ThrowAsync<SnapshotValidationNodeImmutableException>();
    }

    [Fact]
    [ContractTest("RS-BATCH")]
    public async Task RS_BATCH_LIMIT_Enforced()
    {
        var (planId, _) = await this.SeedPlanAsync(("A", JobStatus.Pending, Array.Empty<string>()));

        var reshaper = CreateReshaper(this.store, new PlanReshapeOptions { MaxOpsPerCall = 2 });

        var ops = ImmutableArray.Create<ReshapeOperation>(
            new AddJob(MakeNode(JobId.New(), "B"), ImmutableArray<JobId>.Empty),
            new AddJob(MakeNode(JobId.New(), "C"), ImmutableArray<JobId>.Empty),
            new AddJob(MakeNode(JobId.New(), "D"), ImmutableArray<JobId>.Empty));

        var act = async () => await reshaper.ApplyAsync(
            planId,
            ops,
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ReshapeRejectedException>();
        ex.Which.Failures.Should().ContainSingle().Which.FailureReason.Should().Be("BatchLimitExceeded");
    }
}

// -------------------- shared test doubles (duplicated from PlanStore.Tests; those are `internal`) --------------------

internal sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    private readonly T value;

    public StaticOptionsMonitor(T value) => this.value = value;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable OnChange(Action<T, string?> listener) => new NoopDisposable();

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose() { }
    }
}

internal sealed class NullFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(false);

    public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(string.Empty);

    public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => default;

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) => new((Stream)new MemoryStream());

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => default;

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
}

internal sealed class NullEventBus : IEventBus
{
    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull => default;

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => new NullDisposable();

    private sealed class NullDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => default;
    }
}
