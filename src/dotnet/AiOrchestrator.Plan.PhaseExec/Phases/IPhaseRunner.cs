// <copyright file="IPhaseRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Seam for individual phase implementations. Each phase encapsulates exactly one
/// stage of the per-job pipeline and is invoked by <see cref="PhaseExecutor"/> in fixed order.
/// Failures must be raised as <see cref="PhaseExecutionException"/> so the executor can route
/// them through the heal-or-resume strategy.
/// </summary>
public interface IPhaseRunner
{
    /// <summary>Gets the phase this runner implements.</summary>
    JobPhase Phase { get; }

    /// <summary>Runs the phase. Throws <see cref="PhaseExecutionException"/> on failure.</summary>
    /// <param name="ctx">Per-job context.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An optional commit SHA produced by the Commit phase; <see langword="null"/> for all other phases.</returns>
    ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct);
}

/// <summary>Runtime context threaded through every phase in a single attempt.</summary>
public sealed record PhaseRunContext
{
    /// <summary>Gets the plan identifier.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job identifier.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the run identifier.</summary>
    public required RunId RunId { get; init; }

    /// <summary>Gets the job snapshot at the start of the attempt.</summary>
    public required JobNode Job { get; init; }

    /// <summary>Gets the 1-based attempt number.</summary>
    public required int AttemptNumber { get; init; }

    /// <summary>Gets a value indicating whether the current attempt is an auto-heal retry.</summary>
    public required bool IsAutoHealAttempt { get; init; }
}
