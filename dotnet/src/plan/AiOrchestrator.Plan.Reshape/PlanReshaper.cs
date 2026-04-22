// <copyright file="PlanReshaper.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Reshape.Validation;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>
/// Applies atomic batched reshape operations (add / remove / reorder) to a live plan per §3.12.4.
/// Validates the entire batch BEFORE applying any mutation (RS-TXN-1) and commits every mutation
/// through <see cref="IPlanStore"/> using idempotency sub-keys derived from a single caller-supplied
/// <see cref="IdempotencyKey"/> (RS-TXN-2).
/// </summary>
public sealed class PlanReshaper
{
    private readonly IPlanStore store;
    private readonly IClock clock;
    private readonly IOptionsMonitor<PlanReshapeOptions> opts;
    private readonly CycleGuard cycleGuard = new();

    /// <summary>Initialises a new <see cref="PlanReshaper"/>.</summary>
    /// <param name="store">The durable plan store (all mutations flow through it — INV-10).</param>
    /// <param name="clock">Clock abstraction (reserved for future timestamp needs).</param>
    /// <param name="opts">Options monitor supplying <see cref="PlanReshapeOptions"/>.</param>
    public PlanReshaper(IPlanStore store, IClock clock, IOptionsMonitor<PlanReshapeOptions> opts)
    {
        this.store = store ?? throw new ArgumentNullException(nameof(store));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
    }

    /// <summary>
    /// Applies <paramref name="ops"/> atomically against the plan identified by <paramref name="planId"/>.
    /// If validation of any op fails, the exception <see cref="ReshapeRejectedException"/> is thrown and
    /// NO mutation is persisted (RS-TXN-1).
    /// </summary>
    /// <param name="planId">The plan to reshape.</param>
    /// <param name="ops">The operations in evaluation / application order.</param>
    /// <param name="idemKey">Batch-level idempotency key (RS-TXN-2).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ReshapeResult"/> describing per-op outcomes and final plan state.</returns>
    public async ValueTask<ReshapeResult> ApplyAsync(PlanId planId, ImmutableArray<ReshapeOperation> ops, IdempotencyKey idemKey, CancellationToken ct)
    {
        var options = this.opts.CurrentValue;

        // INV-9 / RS-BATCH: enforce batch size.
        if (ops.IsDefault || ops.Length == 0)
        {
            throw new ArgumentException("Reshape batch must contain at least one operation.", nameof(ops));
        }

        if (ops.Length > options.MaxOpsPerCall)
        {
            var failure = new OperationResult
            {
                Op = ops[0],
                Success = false,
                FailureReason = FailureReasons.BatchLimitExceeded,
                AffectedJobId = null,
            };
            throw new ReshapeRejectedException { Failures = ImmutableArray.Create(failure) };
        }

        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan not found: {planId}");

        // Project the entire batch in-memory; collect per-op results.
        var graph = PlanGraph.From(plan);
        var results = new List<OperationResult>(ops.Length);
        var planned = new List<PlannedMutation>(ops.Length * 2);
        bool anyFailure = false;

        foreach (var op in ops)
        {
            var outcome = this.ValidateAndProject(op, graph, options);
            results.Add(outcome.Result);
            if (!outcome.Result.Success)
            {
                anyFailure = true;
                continue;
            }

            graph = outcome.ProjectedGraph!;
            planned.AddRange(outcome.Mutations);
        }

        if (anyFailure)
        {
            // RS-TXN-1: atomic — nothing persisted.
            throw new ReshapeRejectedException { Failures = results.ToImmutableArray() };
        }

        // All valid — write every mutation with its derived sub-key (RS-TXN-2).
        int mutationIndex = 0;
        foreach (var pm in planned)
        {
            var subKey = DeriveSubKey(idemKey, mutationIndex++);
            await this.store.MutateAsync(planId, pm.Mutation, subKey, ct).ConfigureAwait(false);
        }

        var updated = await this.store.LoadAsync(planId, ct).ConfigureAwait(false) ?? plan;
        return new ReshapeResult
        {
            PerOperation = results.ToImmutableArray(),
            UpdatedPlan = updated,
        };
    }

    private ValidationOutcome ValidateAndProject(ReshapeOperation op, PlanGraph graph, PlanReshapeOptions options)
    {
        switch (op)
        {
            case AddJob add:
                return this.ValidateAddJob(add, graph, options);
            case RemoveJob rm:
                return ValidateRemove(rm, graph);
            case UpdateDeps upd:
                return this.ValidateUpdateDeps(upd, graph);
            case AddBefore before:
                return this.ValidateAddBefore(before, graph, options);
            case AddAfter after:
                return this.ValidateAddAfter(after, graph, options);
            default:
                return Fail(op, FailureReasons.UnknownOperation, null);
        }
    }

    private ValidationOutcome ValidateAddJob(AddJob add, PlanGraph graph, PlanReshapeOptions options)
    {
        if (add.Spec is null)
        {
            return Fail(add, FailureReasons.InvalidSpec, null);
        }

        if (string.IsNullOrEmpty(add.Spec.Id))
        {
            return Fail(add, FailureReasons.InvalidSpec, null);
        }

        if (IsSnapshotValidationNode(add.Spec.Id))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (graph.Jobs.ContainsKey(add.Spec.Id))
        {
            return Fail(add, FailureReasons.DuplicateJobId, TryId(add.Spec.Id));
        }

        foreach (var dep in add.Dependencies)
        {
            if (!graph.Jobs.ContainsKey(dep.ToString()))
            {
                return Fail(add, FailureReasons.UnknownDependency, TryId(add.Spec.Id));
            }
        }

        var projected = CycleGuard.Project(graph, add);
        if (this.cycleGuard.WouldCreateCycle(graph, add).Cycle)
        {
            return Fail(add, FailureReasons.Cycle, TryId(add.Spec.Id));
        }

        if (!CheckDagLimits(projected, options, out var limitReason))
        {
            return Fail(add, limitReason!, TryId(add.Spec.Id));
        }

        var node = add.Spec with { DependsOn = add.Dependencies.Select(d => d.ToString()).ToArray() };
        return Ok(
            add,
            projected,
            TryId(node.Id),
            new PlannedMutation(new JobAdded(0, default, default, node)));
    }

    private static ValidationOutcome ValidateRemove(RemoveJob rm, PlanGraph graph)
    {
        var key = rm.TargetJobId.ToString();
        if (IsSnapshotValidationNode(key))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (!graph.Jobs.TryGetValue(key, out var node))
        {
            return Fail(rm, FailureReasons.UnknownJob, rm.TargetJobId);
        }

        if (node.Status is not (JobStatus.Pending or JobStatus.Ready))
        {
            return Fail(rm, FailureReasons.StatusNotRemovable, rm.TargetJobId);
        }

        var projected = CycleGuard.Project(graph, rm);
        return Ok(
            rm,
            projected,
            rm.TargetJobId,
            new PlannedMutation(new JobRemoved(0, default, default, key)));
    }

    private ValidationOutcome ValidateUpdateDeps(UpdateDeps upd, PlanGraph graph)
    {
        var key = upd.TargetJobId.ToString();
        if (IsSnapshotValidationNode(key))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (!graph.Jobs.TryGetValue(key, out var node))
        {
            return Fail(upd, FailureReasons.UnknownJob, upd.TargetJobId);
        }

        if (node.Status != JobStatus.Pending)
        {
            return Fail(upd, FailureReasons.StatusNotUpdatable, upd.TargetJobId);
        }

        foreach (var d in upd.NewDependencies)
        {
            if (!graph.Jobs.ContainsKey(d.ToString()))
            {
                return Fail(upd, FailureReasons.UnknownDependency, upd.TargetJobId);
            }
        }

        if (this.cycleGuard.WouldCreateCycle(graph, upd).Cycle)
        {
            return Fail(upd, FailureReasons.Cycle, upd.TargetJobId);
        }

        var projected = CycleGuard.Project(graph, upd);
        var depStrings = upd.NewDependencies.Select(d => d.ToString()).ToImmutableArray();
        return Ok(
            upd,
            projected,
            upd.TargetJobId,
            new PlannedMutation(new JobDepsUpdated(0, default, default, key, depStrings)));
    }

    private ValidationOutcome ValidateAddBefore(AddBefore before, PlanGraph graph, PlanReshapeOptions options)
    {
        var existingKey = before.ExistingJobId.ToString();
        if (IsSnapshotValidationNode(existingKey))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (before.NewJobSpec is null || string.IsNullOrEmpty(before.NewJobSpec.Id))
        {
            return Fail(before, FailureReasons.InvalidSpec, null);
        }

        if (IsSnapshotValidationNode(before.NewJobSpec.Id))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (!graph.Jobs.TryGetValue(existingKey, out var existing))
        {
            return Fail(before, FailureReasons.UnknownJob, before.ExistingJobId);
        }

        if (graph.Jobs.ContainsKey(before.NewJobSpec.Id))
        {
            return Fail(before, FailureReasons.DuplicateJobId, TryId(before.NewJobSpec.Id));
        }

        if (existing.Status != JobStatus.Pending)
        {
            return Fail(before, FailureReasons.StatusNotUpdatable, before.ExistingJobId);
        }

        foreach (var d in before.NewJobDependencies)
        {
            if (!graph.Jobs.ContainsKey(d.ToString()))
            {
                return Fail(before, FailureReasons.UnknownDependency, TryId(before.NewJobSpec.Id));
            }
        }

        if (this.cycleGuard.WouldCreateCycle(graph, before).Cycle)
        {
            return Fail(before, FailureReasons.Cycle, TryId(before.NewJobSpec.Id));
        }

        var projected = CycleGuard.Project(graph, before);
        if (!CheckDagLimits(projected, options, out var limitReason))
        {
            return Fail(before, limitReason!, TryId(before.NewJobSpec.Id));
        }

        var newNode = before.NewJobSpec with
        {
            DependsOn = before.NewJobDependencies.Select(d => d.ToString()).ToArray(),
        };
        var existingDepsUpdated = existing.DependsOn.Contains(newNode.Id, StringComparer.Ordinal)
            ? existing.DependsOn.ToImmutableArray()
            : new[] { newNode.Id }.Concat(existing.DependsOn).ToImmutableArray();

        return Ok(
            before,
            projected,
            TryId(newNode.Id),
            new PlannedMutation(new JobAdded(0, default, default, newNode)),
            new PlannedMutation(new JobDepsUpdated(0, default, default, existingKey, existingDepsUpdated)));
    }

    private ValidationOutcome ValidateAddAfter(AddAfter after, PlanGraph graph, PlanReshapeOptions options)
    {
        var existingKey = after.ExistingJobId.ToString();
        if (IsSnapshotValidationNode(existingKey))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (after.NewJobSpec is null || string.IsNullOrEmpty(after.NewJobSpec.Id))
        {
            return Fail(after, FailureReasons.InvalidSpec, null);
        }

        if (IsSnapshotValidationNode(after.NewJobSpec.Id))
        {
            throw new SnapshotValidationNodeImmutableException();
        }

        if (!graph.Jobs.ContainsKey(existingKey))
        {
            return Fail(after, FailureReasons.UnknownJob, after.ExistingJobId);
        }

        if (graph.Jobs.ContainsKey(after.NewJobSpec.Id))
        {
            return Fail(after, FailureReasons.DuplicateJobId, TryId(after.NewJobSpec.Id));
        }

        // RS-AFTER-2: cycle check BEFORE rewiring.
        if (this.cycleGuard.WouldCreateCycle(graph, after).Cycle)
        {
            return Fail(after, FailureReasons.Cycle, TryId(after.NewJobSpec.Id));
        }

        var projected = CycleGuard.Project(graph, after);
        if (!CheckDagLimits(projected, options, out var limitReason))
        {
            return Fail(after, limitReason!, TryId(after.NewJobSpec.Id));
        }

        var newNode = after.NewJobSpec with { DependsOn = new[] { existingKey } };
        var mutations = new List<PlannedMutation>
        {
            new(new JobAdded(0, default, default, newNode)),
        };

        // RS-AFTER-1: rewire every previous successor of the existing job.
        foreach (var (id, node) in graph.Jobs)
        {
            if (id == newNode.Id)
            {
                continue;
            }

            if (node.DependsOn.Contains(existingKey, StringComparer.Ordinal))
            {
                var rewired = node.DependsOn
                    .Select(d => string.Equals(d, existingKey, StringComparison.Ordinal) ? newNode.Id : d)
                    .Distinct(StringComparer.Ordinal)
                    .ToImmutableArray();
                mutations.Add(new PlannedMutation(new JobDepsUpdated(0, default, default, id, rewired)));
            }
        }

        return Ok(after, projected, TryId(newNode.Id), mutations.ToArray());
    }

    private static bool CheckDagLimits(PlanGraph projected, PlanReshapeOptions options, out string? failureReason)
    {
        if (projected.Jobs.Count > options.MaxJobs)
        {
            failureReason = FailureReasons.MaxJobsExceeded;
            return false;
        }

        if (projected.CountParallelRoots() > options.MaxParallel)
        {
            failureReason = FailureReasons.MaxParallelExceeded;
            return false;
        }

        failureReason = null;
        return true;
    }

    private static bool IsSnapshotValidationNode(string jobKey)
        => string.Equals(jobKey, SnapshotValidationNodeImmutableException.NodeId, StringComparison.Ordinal);

    private static JobId? TryId(string s)
        => JobId.TryParse(s, out var id) ? id : null;

    private static ValidationOutcome Fail(ReshapeOperation op, string reason, JobId? affected)
    {
        var result = new OperationResult
        {
            Op = op,
            Success = false,
            FailureReason = reason,
            AffectedJobId = affected,
        };
        return new ValidationOutcome(result, null, Array.Empty<PlannedMutation>());
    }

    private static ValidationOutcome Ok(ReshapeOperation op, PlanGraph projected, JobId? affected, params PlannedMutation[] mutations)
    {
        var result = new OperationResult
        {
            Op = op,
            Success = true,
            FailureReason = null,
            AffectedJobId = affected,
        };
        return new ValidationOutcome(result, projected, mutations);
    }

    private static IdempotencyKey DeriveSubKey(IdempotencyKey batchKey, int index)
    {
        var payload = Encoding.UTF8.GetBytes($"reshape:{batchKey.Value}:{index}");
        return IdempotencyKey.FromContent(payload);
    }

    private readonly record struct ValidationOutcome(OperationResult Result, PlanGraph? ProjectedGraph, IReadOnlyList<PlannedMutation> Mutations);

    private readonly record struct PlannedMutation(PlanMutation Mutation);

    private static class FailureReasons
    {
        public const string BatchLimitExceeded = "BatchLimitExceeded";
        public const string InvalidSpec = "InvalidSpec";
        public const string DuplicateJobId = "DuplicateJobId";
        public const string UnknownJob = "UnknownJob";
        public const string UnknownDependency = "UnknownDependency";
        public const string StatusNotRemovable = "StatusNotRemovable";
        public const string StatusNotUpdatable = "StatusNotUpdatable";
        public const string Cycle = "Cycle";
        public const string MaxJobsExceeded = "DagLimitExceeded:MaxJobs";
        public const string MaxParallelExceeded = "DagLimitExceeded:MaxParallel";
        public const string UnknownOperation = "UnknownOperation";
    }
}
