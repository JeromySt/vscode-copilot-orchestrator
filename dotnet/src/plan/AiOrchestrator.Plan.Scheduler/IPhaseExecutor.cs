// <copyright file="IPhaseExecutor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Scheduler;

/// <summary>
/// Stub interface for the phase executor (implemented by job 031).
/// Executes all phases for a single job node within its worktree.
/// </summary>
public interface IPhaseExecutor
{
    /// <summary>Executes all phases for the specified job node.</summary>
    /// <param name="planId">The plan containing the job.</param>
    /// <param name="jobId">The job node to execute.</param>
    /// <param name="ct">Cancellation token. Cancellation aborts the job mid-phase.</param>
    /// <returns>A task that completes when all phases finish (or are aborted).</returns>
    ValueTask ExecuteAsync(PlanId planId, JobId jobId, CancellationToken ct);
}
