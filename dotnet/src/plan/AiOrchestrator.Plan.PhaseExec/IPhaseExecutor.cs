// <copyright file="IPhaseExecutor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Executes the per-job phase machine (§3.12.6) for a single job node within
/// its allocated worktree, including HEAL-RESUME-* recovery and DISK-PLAN-* enforcement.
/// </summary>
public interface IPhaseExecutor
{
    /// <summary>Runs the full phase pipeline for the specified job.</summary>
    /// <param name="planId">The plan owning the job.</param>
    /// <param name="jobId">The job to execute.</param>
    /// <param name="runId">The run identifier for this attempt-cycle (used for telemetry).</param>
    /// <param name="ct">Cancellation token; cancellation aborts the current phase within ≤1 s (INV-12).</param>
    /// <returns>A <see cref="PhaseExecResult"/> describing the terminal outcome.</returns>
    ValueTask<PhaseExecResult> ExecuteAsync(PlanId planId, JobId jobId, RunId runId, CancellationToken ct);
}
