// <copyright file="PlanStoreContractTests.cs" company="AiOrchestrator contributors">
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
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Plan = AiOrchestrator.Plan.Models.Plan;

namespace PlanStoreTestsNs;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

/// <summary>Acceptance contract tests for <see cref="PlanStore"/> (job 028).</summary>
public sealed class PlanStoreContractTests : IDisposable
{
    private readonly string root;

    public PlanStoreContractTests()
    {
        this.root = Path.Combine(
            AppContext.BaseDirectory,
            "ps-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
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

    [Fact]
    [ContractTest("PLAN-STORE-1")]
    public async Task PLAN_STORE_RoundTrip_CreateLoad()
    {
        await using var store = this.CreateStore();

        var initial = new Plan { Name = "Demo", Description = "A demo plan", Status = PlanStatus.Pending };
        var id = await store.CreateAsync(initial, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var node = new JobNode { Id = "job-1", Title = "First", Status = JobStatus.Pending };
        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, node),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "job-1", JobStatus.Ready),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "job-1", JobStatus.Scheduled),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "job-1", JobStatus.Running),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        // Dispose the in-memory view and reload from disk (checkpoint + journal replay).
        await store.DisposeAsync();

        await using var store2 = this.CreateStore();
        var loaded = await store2.LoadAsync(id, CancellationToken.None);

        Assert.NotNull(loaded);
        Assert.Equal("Demo", loaded!.Name);
        Assert.True(loaded.Jobs.ContainsKey("job-1"));
        Assert.Equal(JobStatus.Running, loaded.Jobs["job-1"].Status);
    }

    [Fact]
    [ContractTest("RW-2-IDEM-1")]
    public async Task RW_2_IDEM_1_RetryWithSameKeyAndContentIsNoop()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var node = new JobNode { Id = "j1", Title = "A", Status = JobStatus.Pending };
        var mutation = new JobAdded(0, default, default, node);
        var idem = IdempotencyKey.FromGuid(Guid.NewGuid());

        await store.MutateAsync(id, mutation, idem, CancellationToken.None);

        // Retry with same key + same content → no-op (same seq, no second journal entry).
        await store.MutateAsync(id, mutation, idem, CancellationToken.None);

        var entries = new List<PlanMutation>();
        await foreach (var m in store.ReadJournalAsync(id, 0, CancellationToken.None))
        {
            entries.Add(m);
        }

        Assert.Equal(1, entries.Count);
    }

    [Fact]
    [ContractTest("RW-2-IDEM-2")]
    public async Task RW_2_IDEM_2_RetryWithSameKeyDifferentContentThrows()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var idem = IdempotencyKey.FromGuid(Guid.NewGuid());
        var first = new JobAdded(0, default, default, new JobNode { Id = "j1", Title = "One" });
        var second = new JobAdded(0, default, default, new JobNode { Id = "j2", Title = "Two" });

        await store.MutateAsync(id, first, idem, CancellationToken.None);

        var act = async () => await store.MutateAsync(id, second, idem, CancellationToken.None);
        var ex = await Assert.ThrowsAsync<IdempotencyConflictException>(act);
        Assert.Equal(idem, ex.Key);
        Assert.NotNull(ex.StoredMutation);
        Assert.NotNull(ex.NewMutation);
        Assert.Equal("j1", ((JobAdded)ex.StoredMutation).Node.Id);
        Assert.Equal("j2", ((JobAdded)ex.NewMutation).Node.Id);
    }

    [Fact]
    [ContractTest("RW-2-IDEM-3")]
    public void RW_2_IDEM_3_KeyComputedFromCanonicalContent()
    {
        var content = "hello-world"u8.ToArray();
        var k1 = IdempotencyKey.FromContent(content);
        var k2 = IdempotencyKey.FromContent(content);

        Assert.Equal(k2, k1);
        Assert.Equal(64, k1.Value.Length);
        Assert.Matches("^[0-9A-F]+$", k1.Value);

        var k3 = IdempotencyKey.FromContent("different"u8.ToArray());
        Assert.NotEqual(k1, k3);
    }

    [Fact]
    [ContractTest("PLAN-STORE-CHECK-ATOMIC")]
    public async Task PLAN_STORE_CheckpointAtomicOnCrash()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, new JobNode { Id = "j", Title = "J" }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.CheckpointAsync(id, CancellationToken.None);

        var planDir = Path.Combine(this.root, id.ToString());
        var cpPath = Path.Combine(planDir, "checkpoint.json");
        var tmpPath = cpPath + ".tmp";

        // Simulate a crash: leave a partial .tmp file behind. The final checkpoint must remain valid.
        File.WriteAllText(tmpPath, "this-is-partial-garbage-not-valid-json");

        await using var store2 = this.CreateStore();
        var loaded = await store2.LoadAsync(id, CancellationToken.None);
        Assert.NotNull(loaded);
        Assert.True(loaded!.Jobs.ContainsKey("j"));

        // Final checkpoint file is a single valid JSON document.
        Assert.True(File.Exists(cpPath));
        var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(cpPath));
        Assert.Equal("p", doc.RootElement.GetProperty("plan").GetProperty("name").GetString());
    }

    [Fact]
    [ContractTest("PLAN-STORE-WATCH")]
    public async Task PLAN_STORE_WatchReplayThenLive_NoGapNoDup()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, new JobNode { Id = "j1", Title = "One" }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        using var cts = new CancellationTokenSource();
        var received = new List<Plan>();

        var watch = Task.Run(async () =>
        {
            await foreach (var snap in store.WatchAsync(id, cts.Token))
            {
                received.Add(snap);
                if (received.Count >= 5)
                {
                    break;
                }
            }
        });

        // Wait briefly for the watcher to register and yield the initial snapshot.
        await Task.Delay(100);

        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, new JobNode { Id = "j2", Title = "Two" }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "j1", JobStatus.Ready),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "j1", JobStatus.Scheduled),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobStatusUpdated(0, default, default, "j1", JobStatus.Running),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        await watch.WaitAsync(TimeSpan.FromSeconds(5));

        // First snapshot = replay of current state (j1 present).
        Assert.True(received[0].Jobs.ContainsKey("j1"));

        // Subsequent snapshots reflect live mutations — no gap, no dup.
        Assert.True(received[1].Jobs.ContainsKey("j1"));
        Assert.True(received[1].Jobs.ContainsKey("j2"));
        Assert.Equal(JobStatus.Running, received[4].Jobs["j1"].Status);

        // No duplicate snapshots — each is distinct.
        Assert.Equal(received.Count(), received.Distinct().Count());
    }

    [Fact]
    [ContractTest("PLAN-STORE-GAP")]
    public async Task PLAN_STORE_JournalGapDetected()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, new JobNode { Id = "j1", Title = "One" }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobAdded(0, default, default, new JobNode { Id = "j2", Title = "Two" }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);

        await store.DisposeAsync();

        // Corrupt the journal by introducing a gap: remove the middle entry.
        var planDir = Path.Combine(this.root, id.ToString());
        var journalPath = Path.Combine(planDir, "journal.ndjson");
        var lines = File.ReadAllLines(journalPath);
        Assert.True(lines.Length > 1);

        // Remove the FIRST line, producing a journal that starts with seq=1 then... but expected=1 after seq=1;
        // more reliably, construct a true gap by skipping a middle entry.
        // Add a 3rd entry first.
        await using (var store2 = this.CreateStore())
        {
            await store2.MutateAsync(
                id,
                new JobAdded(0, default, default, new JobNode { Id = "j3", Title = "Three" }),
                IdempotencyKey.FromGuid(Guid.NewGuid()),
                CancellationToken.None);
        }

        lines = File.ReadAllLines(journalPath);
        Assert.True(lines.Length >= 3);

        // Remove middle line to produce a numeric gap.
        var truncated = new List<string> { lines[0], lines[^1] };
        File.WriteAllLines(journalPath, truncated);

        await using var store3 = this.CreateStore();
        var act = async () => await store3.LoadAsync(id, CancellationToken.None);
        await Assert.ThrowsAsync<PlanJournalCorruptedException>(act);
    }

    [Fact]
    [ContractTest("PLAN-STORE-AUTOCHK")]
    public async Task PLAN_STORE_AutoCheckpointTriggers()
    {
        var opts = new PlanStoreOptions { CheckpointAfterMutations = 3, CheckpointAfterTime = TimeSpan.FromHours(1) };
        await using var store = this.CreateStore(opts);
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        for (int i = 0; i < 5; i++)
        {
            await store.MutateAsync(
                id,
                new JobAdded(0, default, default, new JobNode { Id = $"j{i}", Title = $"J{i}" }),
                IdempotencyKey.FromGuid(Guid.NewGuid()),
                CancellationToken.None);
        }

        var cpPath = Path.Combine(this.root, id.ToString(), "checkpoint.json");
        var cpText = File.ReadAllText(cpPath);
        using var doc = System.Text.Json.JsonDocument.Parse(cpText);
        var upToSeq = doc.RootElement.GetProperty("upToSeq").GetInt64();
        Assert.True(upToSeq >= 2);
    }

    [Fact]
    [ContractTest("PLAN-STORE-LIST")]
    public async Task PLAN_STORE_ListEnumeratesLazily()
    {
        await using var store = this.CreateStore();
        var ids = new List<PlanId>();
        for (int i = 0; i < 5; i++)
        {
            ids.Add(await store.CreateAsync(new Plan { Name = $"p{i}" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None));
        }

        // Enumerate only the first 2 without fully consuming the sequence — lazy.
        var taken = new List<Plan>();
        await foreach (var p in store.ListAsync(CancellationToken.None))
        {
            taken.Add(p);
            if (taken.Count >= 2)
            {
                break;
            }
        }

        Assert.Equal(2, taken.Count);

        // Fully enumerating yields all.
        var all = new List<Plan>();
        await foreach (var p in store.ListAsync(CancellationToken.None))
        {
            all.Add(p);
        }

        Assert.Equal(5, all.Count);
        Assert.Equivalent(new[] { "p0", "p1", "p2", "p3", "p4" }, all.Select(p => p.Name));
    }

    private PlanStore CreateStore(PlanStoreOptions? options = null)
    {
        var clock = new InMemoryClock();
        var fs = new NullFileSystem();
        var bus = new NullEventBus();
        var opts = new StaticOptionsMonitor<PlanStoreOptions>(options ?? new PlanStoreOptions());
        return new PlanStore(new AbsolutePath(this.root), fs, clock, bus, opts, NullLogger<PlanStore>.Instance);
    }
}

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
    public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
        where TEvent : notnull => default;

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => new NullDisposable();

    private sealed class NullDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => default;
    }
}

/// <summary>Extra coverage tests exercising every mutation type and edge paths not covered by acceptance tests.</summary>
public sealed class PlanStoreCoverageTests : IDisposable
{
    private readonly string root;

    public PlanStoreCoverageTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "ps-cov", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.root))
            {
                Directory.Delete(this.root, recursive: true);
            }
        }
        catch
        {
        }
    }

    [Fact]
    public async Task AllMutationTypes_ApplyAndSerialize()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "cov" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var node1 = new JobNode { Id = "j1", Title = "One", Status = JobStatus.Pending };
        var node2 = new JobNode { Id = "j2", Title = "Two", Status = JobStatus.Pending };

        await store.MutateAsync(id, new JobAdded(0, default, default, node1), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobAdded(0, default, default, node2), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobDepsUpdated(0, default, default, "j2", ImmutableArray.Create("j1")), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j1", JobStatus.Ready), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j1", JobStatus.Scheduled), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j1", JobStatus.Running), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobAttemptRecorded(0, default, default, "j1", new JobAttempt { AttemptNumber = 1, StartedAt = DateTimeOffset.UtcNow, Status = JobStatus.Running }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(id, new PlanStatusUpdated(0, default, default, PlanStatus.Running), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobRemoved(0, default, default, "j2"), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        await store.CheckpointAsync(id, CancellationToken.None);
        await store.DisposeAsync();

        // Reload from journal+checkpoint and assert the final state.
        await using var store2 = this.CreateStore();
        var loaded = await store2.LoadAsync(id, CancellationToken.None);
        Assert.NotNull(loaded);
        Assert.Equal(PlanStatus.Running, loaded!.Status);
        Assert.True(loaded.Jobs.ContainsKey("j1"));
        Assert.False(loaded.Jobs.ContainsKey("j2"));
        Assert.Equal(JobStatus.Running, loaded.Jobs["j1"].Status);
        Assert.Equal(1, loaded.Jobs["j1"].Attempts.Count);
    }

    [Fact]
    public async Task Mutations_TargetingMissingJob_AreNoops()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "x" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        // Each targets a nonexistent job; applier branches should return plan unchanged.
        await store.MutateAsync(id, new JobDepsUpdated(0, default, default, "missing", ImmutableArray<string>.Empty), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "missing", JobStatus.Running), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(
            id,
            new JobAttemptRecorded(0, default, default, "missing", new JobAttempt { AttemptNumber = 1, StartedAt = DateTimeOffset.UtcNow, Status = JobStatus.Running }),
            IdempotencyKey.FromGuid(Guid.NewGuid()),
            CancellationToken.None);
        await store.MutateAsync(id, new JobRemoved(0, default, default, "missing"), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        var loaded = await store.LoadAsync(id, CancellationToken.None);
        Assert.Empty(loaded!.Jobs);
    }

    [Fact]
    public async Task LoadAsync_UnknownPlan_ReturnsNull()
    {
        await using var store = this.CreateStore();
        var loaded = await store.LoadAsync(PlanId.Parse($"plan_{Guid.NewGuid():N}"), CancellationToken.None);
        Assert.Null(loaded);
    }

    [Fact]
    public async Task ReadJournal_WithFromSeq_SkipsEarlyEntries()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "p" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        for (int i = 0; i < 4; i++)
        {
            await store.MutateAsync(
                id,
                new JobAdded(0, default, default, new JobNode { Id = $"j{i}", Title = $"J{i}" }),
                IdempotencyKey.FromGuid(Guid.NewGuid()),
                CancellationToken.None);
        }

        var tail = new List<PlanMutation>();
        await foreach (var m in store.ReadJournalAsync(id, fromSeq: 2, CancellationToken.None))
        {
            tail.Add(m);
        }

        Assert.True(tail.Count < 4);
        Assert.True(tail.All(m => m.Seq >= 2));
    }

    [Fact]
    public void IdempotencyKey_ValueEquality()
    {
        var g = Guid.NewGuid();
        var a = IdempotencyKey.FromGuid(g);
        var b = IdempotencyKey.FromGuid(g);
        Assert.Equal(b, a);
        Assert.Equal(b.GetHashCode(), a.GetHashCode());
        Assert.Equal(g.ToString("N"), a.ToString());

        var empty = default(IdempotencyKey);
        Assert.Equal(string.Empty, empty.ToString());
    }

    [Fact]
    public async Task Checkpoint_ReloadProducesIdenticalSnapshot()
    {
        await using var store = this.CreateStore();
        var id = await store.CreateAsync(new Plan { Name = "cp" }, IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobAdded(0, default, default, new JobNode { Id = "j", Title = "J" }), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.CheckpointAsync(id, CancellationToken.None);

        // Second mutations after checkpoint — follow valid state transitions.
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j", JobStatus.Ready), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j", JobStatus.Scheduled), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j", JobStatus.Running), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);
        await store.MutateAsync(id, new JobStatusUpdated(0, default, default, "j", JobStatus.Succeeded), IdempotencyKey.FromGuid(Guid.NewGuid()), CancellationToken.None);

        await store.DisposeAsync();

        await using var store2 = this.CreateStore();
        var loaded = await store2.LoadAsync(id, CancellationToken.None);
        Assert.Equal(JobStatus.Succeeded, loaded!.Jobs["j"].Status);
    }

    private PlanStore CreateStore(PlanStoreOptions? options = null)
    {
        var clock = new InMemoryClock();
        var fs = new NullFileSystem();
        var bus = new NullEventBus();
        var opts = new StaticOptionsMonitor<PlanStoreOptions>(options ?? new PlanStoreOptions());
        return new PlanStore(new AbsolutePath(this.root), fs, clock, bus, opts, NullLogger<PlanStore>.Instance);
    }
}
