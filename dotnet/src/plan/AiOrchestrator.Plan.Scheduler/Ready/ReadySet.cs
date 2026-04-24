// <copyright file="ReadySet.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Scheduler.Ready;

/// <summary>
/// Computes the set of jobs that are ready to execute from a current status snapshot.
/// A job is ready when it is Pending and every predecessor has Succeeded (INV-1, INV-2).
/// </summary>
internal sealed class ReadySet
{
    private readonly PlanGraph graph;

    /// <summary>Initializes a new instance of the <see cref="ReadySet"/> class.</summary>
    /// <param name="graph">The DAG graph for the plan.</param>
    public ReadySet(PlanGraph graph)
    {
        this.graph = graph;
    }

    /// <summary>
    /// Returns the jobs that are ready to run given the current status snapshot.
    /// A job is ready if it is <see cref="JobStatus.Pending"/> and all predecessors are
    /// <see cref="JobStatus.Succeeded"/> or <see cref="JobStatus.Skipped"/>.
    /// A job is blocked (never ready) if any predecessor is <see cref="JobStatus.Failed"/>,
    /// <see cref="JobStatus.Canceled"/>, or <see cref="JobStatus.Blocked"/>.
    /// Results are sorted by priority: retries first, then most dependents, then alphabetical.
    /// </summary>
    /// <param name="currentStatuses">The current status of each job, keyed by <see cref="JobId"/>.</param>
    /// <param name="plan">The plan used for priority sorting. When <see langword="null"/>, no sorting is applied.</param>
    /// <returns>The set of job IDs ready to execute, sorted by scheduling priority.</returns>
    public ImmutableArray<JobId> ComputeReady(IReadOnlyDictionary<JobId, JobStatus> currentStatuses, AiOrchestrator.Plan.Models.Plan? plan = null)
    {
        var ready = ImmutableArray.CreateBuilder<JobId>();

        foreach (var (jobId, status) in currentStatuses)
        {
            if (status != JobStatus.Pending)
            {
                continue;
            }

            var preds = this.graph.GetPredecessors(jobId.ToString());
            bool allSucceeded = true;
            bool anyTerminalFailure = false;

            foreach (var predStr in preds)
            {
                if (!JobId.TryParse(predStr, out var predId) ||
                    !currentStatuses.TryGetValue(predId, out var predStatus))
                {
                    allSucceeded = false;
                    continue;
                }

                if (predStatus == JobStatus.Failed || predStatus == JobStatus.Canceled || predStatus == JobStatus.Blocked)
                {
                    anyTerminalFailure = true;
                    allSucceeded = false;
                    break;
                }

                if (predStatus != JobStatus.Succeeded && predStatus != JobStatus.Skipped)
                {
                    allSucceeded = false;
                }
            }

            if (!anyTerminalFailure && allSucceeded)
            {
                ready.Add(jobId);
            }
        }

        if (plan is not null && ready.Count > 1)
        {
            ready.Sort(new ReadyJobPriorityComparer(plan));
        }

        return ready.ToImmutable();
    }
}
