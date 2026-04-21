// <copyright file="Mutations.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Store;

/// <summary>Adds a job node to the plan DAG.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="Node">The job node to add.</param>
public sealed record JobAdded(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, JobNode Node)
    : PlanMutation(Seq, IdemKey, At);

/// <summary>Removes a job node from the plan DAG.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="JobIdValue">Job node id (string) to remove.</param>
public sealed record JobRemoved(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, string JobIdValue)
    : PlanMutation(Seq, IdemKey, At);

/// <summary>Replaces the dependency list of a job node.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="JobIdValue">Job node id.</param>
/// <param name="NewDeps">The replacement dependency list.</param>
public sealed record JobDepsUpdated(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, string JobIdValue, System.Collections.Immutable.ImmutableArray<string> NewDeps)
    : PlanMutation(Seq, IdemKey, At);

/// <summary>Updates the lifecycle status of a job node.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="JobIdValue">Job node id.</param>
/// <param name="NewStatus">The new status.</param>
public sealed record JobStatusUpdated(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, string JobIdValue, JobStatus NewStatus)
    : PlanMutation(Seq, IdemKey, At);

/// <summary>Appends a new execution attempt to a job node.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="JobIdValue">Job node id.</param>
/// <param name="Attempt">The attempt to record.</param>
public sealed record JobAttemptRecorded(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, string JobIdValue, JobAttempt Attempt)
    : PlanMutation(Seq, IdemKey, At);

/// <summary>Updates the top-level plan status.</summary>
/// <param name="Seq">Sequence number.</param>
/// <param name="IdemKey">Idempotency key.</param>
/// <param name="At">Timestamp.</param>
/// <param name="NewStatus">The new plan status.</param>
public sealed record PlanStatusUpdated(long Seq, IdempotencyKey IdemKey, DateTimeOffset At, PlanStatus NewStatus)
    : PlanMutation(Seq, IdemKey, At);
