// <copyright file="PlanCompletionHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.Scheduler.Completion;

/// <summary>
/// After each job completes, cascades failures to downstream Pending jobs (Blocked)
/// and derives the plan's terminal status when all jobs have finished.
/// </summary>
public sealed class PlanCompletionHandler
{
    private readonly IPlanStore store;
    private readonly IEventBus bus;
    private readonly IClock clock;
    private readonly ILogger<PlanCompletionHandler> logger;

    /// <summary>Initializes a new instance of the <see cref="PlanCompletionHandler"/> class.</summary>
    /// <param name="store">The durable plan store.</param>
    /// <param name="bus">The event bus for publishing blocked events.</param>
    /// <param name="clock">The clock for timestamping mutations.</param>
    /// <param name="logger">The component logger.</param>
    public PlanCompletionHandler(IPlanStore store, IEventBus bus, IClock clock, ILogger<PlanCompletionHandler> logger)
    {
        this.store = store;
        this.bus = bus;
        this.clock = clock;
        this.logger = logger;
    }

    /// <summary>
    /// Cascades Failed/Canceled/Blocked to downstream Pending jobs,
    /// then derives the plan's terminal status if all jobs are terminal.
    /// Returns <see langword="true"/> if the plan reached a terminal status.
    /// </summary>
    /// <param name="planId">The plan to process.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><see langword="true"/> when the plan transitioned to a terminal status; otherwise <see langword="false"/>.</returns>
    public async Task<bool> ProcessAsync(PlanId planId, CancellationToken ct)
    {
        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false);
        if (plan is null)
        {
            return false;
        }

        // 1. Build a status map keyed by job id string.
        var statuses = new Dictionary<string, JobStatus>(plan.Jobs.Count);
        foreach (var (id, node) in plan.Jobs)
        {
            statuses[id] = node.Status;
        }

        // 2. Cascade: for each Pending job, if any predecessor is terminal-failed, block it.
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (var (id, node) in plan.Jobs)
            {
                if (statuses[id] != JobStatus.Pending)
                {
                    continue;
                }

                string? blockedBy = null;
                foreach (var dep in node.DependsOn)
                {
                    if (statuses.TryGetValue(dep, out var depStatus) && IsTerminalFailed(depStatus))
                    {
                        blockedBy = dep;
                        break;
                    }
                }

                if (blockedBy is not null)
                {
                    var idemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
                    var now = this.clock.UtcNow;

                    await this.store.MutateAsync(
                        planId,
                        new JobStatusUpdated(0, idemKey, now, id, JobStatus.Blocked),
                        idemKey,
                        ct).ConfigureAwait(false);

                    statuses[id] = JobStatus.Blocked;
                    changed = true;

                    if (JobId.TryParse(id, out var blockedJobId) && JobId.TryParse(blockedBy, out var blockerJobId))
                    {
                        await this.bus.PublishAsync(
                            new JobBlockedEvent
                            {
                                PlanId = planId,
                                JobId = blockedJobId,
                                BlockedBy = blockerJobId,
                                At = now,
                            },
                            ct).ConfigureAwait(false);
                    }

                    this.logger.LogInformation(
                        "Job {JobId} blocked by predecessor {BlockedBy} in plan {PlanId}.",
                        id,
                        blockedBy,
                        planId);
                }
            }
        }

        // 3. Derive plan terminal status if all jobs are terminal.
        bool allTerminal = true;
        int succeeded = 0;
        int failedOrBlocked = 0;
        int canceled = 0;

        foreach (var status in statuses.Values)
        {
            if (!IsTerminal(status))
            {
                allTerminal = false;
                break;
            }

            switch (status)
            {
                case JobStatus.Succeeded:
                case JobStatus.Skipped:
                    succeeded++;
                    break;
                case JobStatus.Failed:
                case JobStatus.Blocked:
                    failedOrBlocked++;
                    break;
                case JobStatus.Canceled:
                    canceled++;
                    break;
            }
        }

        if (!allTerminal)
        {
            return false;
        }

        var total = statuses.Count;
        PlanStatus newStatus;

        if (canceled == total)
        {
            newStatus = PlanStatus.Canceled;
        }
        else if (succeeded == total)
        {
            newStatus = PlanStatus.Succeeded;
        }
        else if (succeeded > 0)
        {
            newStatus = PlanStatus.Partial;
        }
        else
        {
            newStatus = PlanStatus.Failed;
        }

        var planIdemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
        await this.store.MutateAsync(
            planId,
            new PlanStatusUpdated(0, planIdemKey, this.clock.UtcNow, newStatus),
            planIdemKey,
            ct).ConfigureAwait(false);

        this.logger.LogInformation(
            "Plan {PlanId} reached terminal status {Status} (succeeded={Succeeded}, failed/blocked={FailedBlocked}, canceled={Canceled}).",
            planId,
            newStatus,
            succeeded,
            failedOrBlocked,
            canceled);

        return true;
    }

    private static bool IsTerminalFailed(JobStatus s) =>
        s is JobStatus.Failed or JobStatus.Canceled or JobStatus.Blocked;

    private static bool IsTerminal(JobStatus s) =>
        s is JobStatus.Succeeded or JobStatus.Failed or JobStatus.Blocked
           or JobStatus.Canceled or JobStatus.Skipped;
}
