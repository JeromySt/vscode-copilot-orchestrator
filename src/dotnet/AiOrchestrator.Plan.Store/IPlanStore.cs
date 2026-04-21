// <copyright file="IPlanStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Durable, journaled plan store per spec §3.12 and §3.31.2.2.
/// Persists plans as a checkpoint snapshot plus an append-only journal of
/// <see cref="PlanMutation"/> entries. Supports replay-then-live watches,
/// content-hash idempotency for retried mutations, and crash-safe atomic writes.
/// </summary>
public interface IPlanStore
{
    /// <summary>Creates a new plan from <paramref name="initialPlan"/>, returning its freshly generated identifier.</summary>
    /// <param name="initialPlan">The initial state of the plan. Its <see cref="AiOrchestrator.Plan.Models.Plan.Id"/> is overwritten.</param>
    /// <param name="idemKey">Idempotency key guarding the creation against retried calls.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The newly assigned <see cref="PlanId"/>.</returns>
    ValueTask<PlanId> CreateAsync(AiOrchestrator.Plan.Models.Plan initialPlan, IdempotencyKey idemKey, CancellationToken ct);

    /// <summary>Loads the current materialized state of a plan (checkpoint + journal replay).</summary>
    /// <param name="id">The plan identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The current plan, or <see langword="null"/> if no plan exists with that id.</returns>
    ValueTask<AiOrchestrator.Plan.Models.Plan?> LoadAsync(PlanId id, CancellationToken ct);

    /// <summary>Applies a mutation to the identified plan.</summary>
    /// <param name="id">The plan identifier.</param>
    /// <param name="mutation">The mutation to apply. <c>Seq</c> and <c>IdemKey</c> fields are overwritten by the store.</param>
    /// <param name="idemKey">Idempotency key for this mutation.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed task.</returns>
    ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct);

    /// <summary>Forces a checkpoint snapshot to disk for the identified plan.</summary>
    /// <param name="id">The plan identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed task.</returns>
    ValueTask CheckpointAsync(PlanId id, CancellationToken ct);

    /// <summary>Enumerates all plans in the store.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A lazy async sequence of plans.</returns>
    IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> ListAsync(CancellationToken ct);

    /// <summary>Reads the raw journal for the identified plan, starting at <paramref name="fromSeq"/>.</summary>
    /// <param name="id">The plan identifier.</param>
    /// <param name="fromSeq">Inclusive starting sequence number.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A lazy async sequence of mutations.</returns>
    IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, CancellationToken ct);

    /// <summary>
    /// Subscribes to snapshots of <paramref name="id"/>. Yields the current snapshot first, then yields a
    /// new snapshot after each subsequent mutation (no gap, no dup) per SUB-3.
    /// </summary>
    /// <param name="id">The plan identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async stream of plan snapshots.</returns>
    IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> WatchAsync(PlanId id, CancellationToken ct);
}
