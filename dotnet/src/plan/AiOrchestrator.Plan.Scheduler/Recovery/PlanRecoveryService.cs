// <copyright file="PlanRecoveryService.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;

namespace AiOrchestrator.Plan.Scheduler.Recovery;

/// <summary>
/// Recovers a canceled or failed plan by resetting eligible jobs to Pending
/// and transitioning the plan to Paused for user review.
/// </summary>
public sealed class PlanRecoveryService
{
    private readonly IPlanStore store;

    /// <summary>Initializes a new instance of the <see cref="PlanRecoveryService"/> class.</summary>
    /// <param name="store">The plan store used to load and mutate plan state.</param>
    public PlanRecoveryService(IPlanStore store)
    {
        this.store = store ?? throw new ArgumentNullException(nameof(store));
    }

    /// <summary>
    /// Recovers a plan by resetting all non-succeeded terminal jobs to Pending.
    /// The plan is placed in Paused status after recovery.
    /// </summary>
    /// <param name="planId">The plan identifier to recover.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The result describing how many jobs were reset.</returns>
    public async Task<PlanRecoveryResult> RecoverAsync(PlanId planId, CancellationToken ct = default)
    {
        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            throw new InvalidOperationException($"Plan '{planId}' not found.");
        }

        if (plan.Status is not (PlanStatus.Failed or PlanStatus.Canceled or PlanStatus.Partial))
        {
            throw new InvalidOperationException(
                $"Cannot recover plan in status {plan.Status}. Only Failed, Canceled, or Partial plans can be recovered.");
        }

        var resetCount = 0;
        var idemBase = $"recovery-{DateTimeOffset.UtcNow.Ticks}";

        foreach (var (id, node) in plan.Jobs)
        {
            if (node.Status is JobStatus.Failed or JobStatus.Canceled or JobStatus.Blocked)
            {
                var idemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
                await this.store.MutateAsync(
                    planId,
                    new JobStatusUpdated(0, idemKey, DateTimeOffset.UtcNow, id, JobStatus.Pending),
                    idemKey,
                    ct).ConfigureAwait(false);
                resetCount++;
            }
        }

        // Transition plan to Paused for user review.
        var planIdemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
        await this.store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, planIdemKey, DateTimeOffset.UtcNow, PlanStatus.Paused),
            planIdemKey,
            ct).ConfigureAwait(false);

        return new PlanRecoveryResult(resetCount, planId);
    }
}

/// <summary>Result of a plan recovery operation.</summary>
/// <param name="JobsReset">The number of jobs that were reset to Pending.</param>
/// <param name="PlanId">The plan that was recovered.</param>
public sealed record PlanRecoveryResult(int JobsReset, PlanId PlanId);
