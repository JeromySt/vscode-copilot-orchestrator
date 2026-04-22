// <copyright file="PhaseExecResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>The outcome of executing all phases for a single job node attempt-cycle.</summary>
public sealed record PhaseExecResult
{
    /// <summary>Gets the terminal status the executor settled on (Succeeded, Failed, or Canceled).</summary>
    public required JobStatus FinalStatus { get; init; }

    /// <summary>Gets the phase the executor was on when it terminated (last phase attempted).</summary>
    public required JobPhase EndedAtPhase { get; init; }

    /// <summary>Gets the commit SHA produced by the Commit phase, or <see langword="null"/> if no commit was produced.</summary>
    public required CommitSha? CommitSha { get; init; }

    /// <summary>Gets the human-readable failure reason, or <see langword="null"/> on success.</summary>
    public required string? FailureReason { get; init; }

    /// <summary>Gets the total number of attempts the executor made (≥ 1).</summary>
    public required int AttemptCount { get; init; }
}
