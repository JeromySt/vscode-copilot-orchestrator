// <copyright file="IPlanStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Abstractions.Plan;

/// <summary>
/// Provides durable persistence of plan state, enabling the orchestrator to survive
/// process restarts and resume in-progress plans.
/// </summary>
public interface IPlanStore
{
    /// <summary>Persists the current state of a plan identified by <paramref name="planId"/>.</summary>
    /// <param name="planId">The plan whose state should be saved.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the state has been durably written.</returns>
    ValueTask SavePlanAsync(PlanId planId, CancellationToken ct);

    /// <summary>Retrieves the current status of a specific job within a plan.</summary>
    /// <param name="plan">The plan containing the job.</param>
    /// <param name="job">The job whose status to retrieve.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The current <see cref="JobStatus"/> of the specified job.</returns>
    ValueTask<JobStatus> GetJobStatusAsync(PlanId plan, JobId job, CancellationToken ct);
}
