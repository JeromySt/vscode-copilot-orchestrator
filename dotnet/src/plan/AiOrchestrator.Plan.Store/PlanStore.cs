// <copyright file="PlanStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store.Events;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Durable plan store per §3.12 and §3.31.2.2. Persists a checkpoint snapshot
/// plus an append-only journal per plan, supports RW-2-IDEM idempotency for
/// retried mutations, and replay-then-live watches (SUB-3).
/// </summary>
public sealed class PlanStore : IPlanStore, IAsyncDisposable
{
    private readonly AbsolutePath storeRoot;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly ILogger<PlanStore> logger;
    private readonly IOptionsMonitor<PlanStoreOptions> opts;

    private readonly ConcurrentDictionary<PlanId, PlanState> plans = new();
    private int disposed;

    /// <summary>Initializes a new <see cref="PlanStore"/>.</summary>
    /// <param name="storeRoot">Root directory holding per-plan subdirectories.</param>
    /// <param name="fs">File-system abstraction.</param>
    /// <param name="clock">Clock abstraction.</param>
    /// <param name="bus">Event bus (reserved for SUB-3 cross-process wiring; watches are local).</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="logger">Logger.</param>
    public PlanStore(
        AbsolutePath storeRoot,
        IFileSystem fs,
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<PlanStoreOptions> opts,
        ILogger<PlanStore> logger)
    {
        this.storeRoot = storeRoot;
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));

        if (!Directory.Exists(storeRoot.Value))
        {
            _ = Directory.CreateDirectory(storeRoot.Value);
        }
    }

    /// <inheritdoc />
    public async ValueTask<PlanId> CreateAsync(AiOrchestrator.Plan.Models.Plan initialPlan, IdempotencyKey idemKey, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(initialPlan);
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);

        var id = PlanId.New();
        var plan = initialPlan with
        {
            Id = id.ToString(),
            CreatedAt = initialPlan.CreatedAt == default ? this.clock.UtcNow : initialPlan.CreatedAt,
        };

        var dir = Path.Combine(this.storeRoot.Value, id.ToString());
        _ = Directory.CreateDirectory(dir);

        var state = new PlanState(this.fs, this.clock, new AbsolutePath(dir), this.opts)
        {
            Plan = plan,
            LastCheckpointAt = this.clock.UtcNow,
            LastCheckpointSeq = -1,
            HighestSeq = -1,
            CreateIdemKey = idemKey,
        };

        await state.InitialCheckpointAsync(ct).ConfigureAwait(false);
        _ = this.plans.TryAdd(id, state);
        return id;
    }

    /// <inheritdoc />
    public async ValueTask<AiOrchestrator.Plan.Models.Plan?> LoadAsync(PlanId id, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);

        if (this.plans.TryGetValue(id, out var cached))
        {
            return cached.GetSnapshot();
        }

        var dir = Path.Combine(this.storeRoot.Value, id.ToString());
        if (!Directory.Exists(dir))
        {
            return null;
        }

        var state = await PlanState.LoadAsync(new AbsolutePath(dir), this.fs, this.clock, this.opts, ct).ConfigureAwait(false);
        if (state == null)
        {
            return null;
        }

        _ = this.plans.TryAdd(id, state);
        return state.GetSnapshot();
    }

    /// <inheritdoc />
    public async ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        ObjectDisposedException.ThrowIf(Volatile.Read(ref this.disposed) != 0, this);

        var state = await this.EnsureLoadedAsync(id, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan not found: {id}");

        // Capture pre-mutation status for event publishing.
        JobStatus? oldJobStatus = null;
        string? jobIdValue = null;
        PlanStatus? oldPlanStatus = null;

        if (mutation is JobStatusUpdated jsu && state.Plan.Jobs.TryGetValue(jsu.JobIdValue, out var oldJob))
        {
            oldJobStatus = oldJob.Status;
            jobIdValue = jsu.JobIdValue;
        }
        else if (mutation is PlanStatusUpdated)
        {
            oldPlanStatus = state.Plan.Status;
        }

        await state.MutateAsync(mutation, idemKey, ct).ConfigureAwait(false);

        // Publish status-change events after successful mutation.
        if (mutation is JobStatusUpdated jsu2 && oldJobStatus.HasValue && oldJobStatus.Value != jsu2.NewStatus
            && JobId.TryParse(jobIdValue!, out var parsedJobId))
        {
            await this.bus.PublishAsync(
                new JobStatusChangedEvent
                {
                    PlanId = id,
                    JobId = parsedJobId,
                    PreviousStatus = oldJobStatus.Value,
                    NewStatus = jsu2.NewStatus,
                    At = this.clock.UtcNow,
                },
                ct).ConfigureAwait(false);
        }
        else if (mutation is PlanStatusUpdated psu && oldPlanStatus.HasValue && oldPlanStatus.Value != psu.NewStatus)
        {
            await this.bus.PublishAsync(
                new PlanStatusChangedEvent
                {
                    PlanId = id,
                    PreviousStatus = oldPlanStatus.Value,
                    NewStatus = psu.NewStatus,
                    At = this.clock.UtcNow,
                },
                ct).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask CheckpointAsync(PlanId id, CancellationToken ct)
    {
        var state = await this.EnsureLoadedAsync(id, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan not found: {id}");
        await state.CheckpointAsync(ct).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> ListAsync([EnumeratorCancellation] CancellationToken ct)
    {
        if (!Directory.Exists(this.storeRoot.Value))
        {
            yield break;
        }

        foreach (var dir in Directory.EnumerateDirectories(this.storeRoot.Value))
        {
            var name = Path.GetFileName(dir);
            if (!PlanId.TryParse(name, out var id))
            {
                continue;
            }

            var p = await this.LoadAsync(id, ct).ConfigureAwait(false);
            if (p != null)
            {
                yield return p;
            }
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, [EnumeratorCancellation] CancellationToken ct)
    {
        var state = await this.EnsureLoadedAsync(id, ct).ConfigureAwait(false);
        if (state == null)
        {
            yield break;
        }

        await foreach (var m in state.Journal.ReadFromAsync(fromSeq, ct).ConfigureAwait(false))
        {
            yield return m;
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> WatchAsync(PlanId id, [EnumeratorCancellation] CancellationToken ct)
    {
        var state = await this.EnsureLoadedAsync(id, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan not found: {id}");

        var (snapshot, channel) = await state.RegisterWatcherAsync(ct).ConfigureAwait(false);
        try
        {
            yield return snapshot;
            await foreach (var p in channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                yield return p;
            }
        }
        finally
        {
            state.UnregisterWatcher(channel);
        }
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        foreach (var s in this.plans.Values)
        {
            s.CompleteAllWatchers();
        }

        return ValueTask.CompletedTask;
    }

    private async ValueTask<PlanState?> EnsureLoadedAsync(PlanId id, CancellationToken ct)
    {
        if (this.plans.TryGetValue(id, out var cached))
        {
            return cached;
        }

        var dir = Path.Combine(this.storeRoot.Value, id.ToString());
        if (!Directory.Exists(dir))
        {
            return null;
        }

        var state = await PlanState.LoadAsync(new AbsolutePath(dir), this.fs, this.clock, this.opts, ct).ConfigureAwait(false);
        if (state != null)
        {
            _ = this.plans.TryAdd(id, state);
        }

        return state;
    }
}

/// <summary>Per-plan runtime state including mutex, journal, checkpointer, watchers.</summary>
internal sealed class PlanState
{
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly AbsolutePath dir;
    private readonly IOptionsMonitor<PlanStoreOptions> opts;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly List<Channel<AiOrchestrator.Plan.Models.Plan>> watchers = new();

    public PlanState(IFileSystem fs, IClock clock, AbsolutePath dir, IOptionsMonitor<PlanStoreOptions> opts)
    {
        this.fs = fs;
        this.clock = clock;
        this.dir = dir;
        this.opts = opts;
        this.Journal = new PlanJournal(new AbsolutePath(Path.Combine(dir.Value, "journal.ndjson")), fs, clock);
        this.Checkpointer = new PlanCheckpointer(new AbsolutePath(Path.Combine(dir.Value, "checkpoint.json")), fs);
    }

    /// <summary>Gets or sets the current in-memory plan snapshot.</summary>
    public AiOrchestrator.Plan.Models.Plan Plan { get; set; } = new();

    /// <summary>Gets or sets the highest applied mutation sequence number.</summary>
    public long HighestSeq { get; set; } = -1;

    /// <summary>Gets or sets the sequence number of the last checkpoint.</summary>
    public long LastCheckpointSeq { get; set; } = -1;

    /// <summary>Gets or sets the timestamp of the last checkpoint.</summary>
    public DateTimeOffset LastCheckpointAt { get; set; }

    /// <summary>Gets or sets the idempotency key used during plan creation.</summary>
    public IdempotencyKey CreateIdemKey { get; set; }

    /// <summary>Gets the plan journal used for mutation append and replay.</summary>
    public PlanJournal Journal { get; }

    /// <summary>Gets the plan checkpointer used for snapshot persistence.</summary>
    public PlanCheckpointer Checkpointer { get; }

    /// <summary>Loads a plan state from disk by replaying the checkpoint and journal.</summary>
    public static async ValueTask<PlanState?> LoadAsync(AbsolutePath dir, IFileSystem fs, IClock clock, IOptionsMonitor<PlanStoreOptions> opts, CancellationToken ct)
    {
        var state = new PlanState(fs, clock, dir, opts);
        var cp = await state.Checkpointer.LoadLatestAsync(ct).ConfigureAwait(false);
        if (cp != null)
        {
            state.Plan = cp.Value.Plan;
            state.LastCheckpointSeq = cp.Value.UpToSeq;
            state.HighestSeq = cp.Value.UpToSeq;
        }
        else
        {
            // No checkpoint — empty plan dir is invalid.
            return null;
        }

        state.LastCheckpointAt = clock.UtcNow;

        // Replay any journal entries with seq > checkpoint.UpToSeq (INV-1).
        await foreach (var m in state.Journal.ReadFromAsync(state.LastCheckpointSeq + 1, ct).ConfigureAwait(false))
        {
            state.Plan = MutationApplier.Apply(state.Plan, m);
            state.HighestSeq = m.Seq;
        }

        return state;
    }

    /// <summary>Writes the initial checkpoint to disk.</summary>
    public async ValueTask InitialCheckpointAsync(CancellationToken ct)
    {
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await this.Checkpointer.WriteAsync(this.Plan, -1, ct).ConfigureAwait(false);
            this.LastCheckpointSeq = -1;
            this.LastCheckpointAt = this.clock.UtcNow;
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Applies a mutation with idempotency checking and auto-checkpointing.</summary>
    public async ValueTask MutateAsync(PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct)
    {
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var existing = await this.Journal.FindByIdempotencyKeyAsync(idemKey, ct).ConfigureAwait(false);
            var contentHash = MutationJson.ContentHash(mutation);
            if (existing != null)
            {
                var existingHash = MutationJson.ContentHash(existing);
                if (string.Equals(existingHash, contentHash, StringComparison.Ordinal)
                    && string.Equals(MutationJson.KindOf(existing), MutationJson.KindOf(mutation), StringComparison.Ordinal))
                {
                    // RW-2-IDEM-1: same key + same content → no-op.
                    return;
                }

                // RW-2-IDEM-2: same key + different content → conflict.
                throw new IdempotencyConflictException
                {
                    Key = idemKey,
                    StoredMutation = existing,
                    NewMutation = AssignSeq(mutation, this.HighestSeq + 1, idemKey, this.clock.UtcNow),
                };
            }

            var assigned = AssignSeq(mutation, this.HighestSeq + 1, idemKey, this.clock.UtcNow);
            await this.Journal.AppendAsync(assigned, contentHash, ct).ConfigureAwait(false);
            this.HighestSeq = assigned.Seq;

            // Apply to in-memory state.
            this.Plan = MutationApplier.Apply(this.Plan, assigned);

            // Auto-checkpoint if thresholds met (INV-9).
            var o = this.opts.CurrentValue;
            var sinceCheckpoint = this.HighestSeq - this.LastCheckpointSeq;
            if (sinceCheckpoint >= o.CheckpointAfterMutations
                || (this.clock.UtcNow - this.LastCheckpointAt) >= o.CheckpointAfterTime)
            {
                await this.Checkpointer.WriteAsync(this.Plan, this.HighestSeq, ct).ConfigureAwait(false);
                this.LastCheckpointSeq = this.HighestSeq;
                this.LastCheckpointAt = this.clock.UtcNow;
            }

            // Notify watchers with a new snapshot.
            var snapshot = this.Plan;
            foreach (var w in this.watchers.ToArray())
            {
                _ = w.Writer.TryWrite(snapshot);
            }
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Forces a checkpoint write to disk.</summary>
    public async ValueTask CheckpointAsync(CancellationToken ct)
    {
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await this.Checkpointer.WriteAsync(this.Plan, this.HighestSeq, ct).ConfigureAwait(false);
            this.LastCheckpointSeq = this.HighestSeq;
            this.LastCheckpointAt = this.clock.UtcNow;
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Returns the current in-memory plan snapshot.</summary>
    public AiOrchestrator.Plan.Models.Plan GetSnapshot() => this.Plan;

    /// <summary>Registers a watcher that receives plan snapshots on each mutation.</summary>
    public async ValueTask<(AiOrchestrator.Plan.Models.Plan Snapshot, Channel<AiOrchestrator.Plan.Models.Plan> Channel)> RegisterWatcherAsync(CancellationToken ct)
    {
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var channel = Channel.CreateUnbounded<AiOrchestrator.Plan.Models.Plan>(new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false,
            });
            this.watchers.Add(channel);
            return (this.Plan, channel);
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Unregisters a watcher channel and completes it.</summary>
    public void UnregisterWatcher(Channel<AiOrchestrator.Plan.Models.Plan> channel)
    {
        this.gate.Wait();
        try
        {
            _ = this.watchers.Remove(channel);
            channel.Writer.TryComplete();
        }
        finally
        {
            _ = this.gate.Release();
        }
    }

    /// <summary>Completes all registered watcher channels and clears the list.</summary>
    public void CompleteAllWatchers()
    {
        foreach (var w in this.watchers.ToArray())
        {
            w.Writer.TryComplete();
        }

        this.watchers.Clear();
    }

    private static PlanMutation AssignSeq(PlanMutation src, long seq, IdempotencyKey idem, DateTimeOffset at) => src switch
    {
        JobAdded m => new JobAdded(seq, idem, at, m.Node),
        JobRemoved m => new JobRemoved(seq, idem, at, m.JobIdValue),
        JobDepsUpdated m => new JobDepsUpdated(seq, idem, at, m.JobIdValue, m.NewDeps),
        JobStatusUpdated m => new JobStatusUpdated(seq, idem, at, m.JobIdValue, m.NewStatus),
        JobAttemptRecorded m => new JobAttemptRecorded(seq, idem, at, m.JobIdValue, m.Attempt),
        PlanStatusUpdated m => new PlanStatusUpdated(seq, idem, at, m.NewStatus),
        _ => throw new NotSupportedException($"Unknown mutation: {src.GetType().FullName}"),
    };
}

/// <summary>Pure function that applies a mutation to an immutable Plan snapshot.</summary>
internal static class MutationApplier
{
    /// <summary>Applies a single mutation to the plan snapshot and returns the updated plan.</summary>
    public static AiOrchestrator.Plan.Models.Plan Apply(AiOrchestrator.Plan.Models.Plan plan, PlanMutation mutation)
    {
        var jobs = new Dictionary<string, JobNode>(plan.Jobs, StringComparer.Ordinal);
        switch (mutation)
        {
            case JobAdded m:
                jobs[m.Node.Id] = m.Node;
                return plan with { Jobs = jobs };

            case JobRemoved m:
                _ = jobs.Remove(m.JobIdValue);
                return plan with { Jobs = jobs };

            case JobDepsUpdated m:
                if (jobs.TryGetValue(m.JobIdValue, out var nd))
                {
                    jobs[m.JobIdValue] = nd with { DependsOn = m.NewDeps.ToArray() };
                    return plan with { Jobs = jobs };
                }

                return plan;

            case JobStatusUpdated m:
                if (jobs.TryGetValue(m.JobIdValue, out var ns))
                {
                    JobStatusTransitions.Validate(ns.Status, m.NewStatus);
                    jobs[m.JobIdValue] = ns with { Status = m.NewStatus };
                    return plan with { Jobs = jobs };
                }

                return plan;

            case JobAttemptRecorded m:
                if (jobs.TryGetValue(m.JobIdValue, out var na))
                {
                    var list = na.Attempts.Concat(new[] { m.Attempt }).ToArray();
                    jobs[m.JobIdValue] = na with { Attempts = list };
                    return plan with { Jobs = jobs };
                }

                return plan;

            case PlanStatusUpdated m:
                return plan with { Status = m.NewStatus };

            default:
                return plan;
        }
    }
}
