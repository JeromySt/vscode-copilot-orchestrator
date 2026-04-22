// <copyright file="JobAttempt.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace AiOrchestrator.Plan.Models;

/// <summary>Represents one attempt to execute a job node, including timing and phase details.</summary>
public sealed record JobAttempt
{
    /// <summary>Gets the 1-based attempt number.</summary>
    public int AttemptNumber { get; init; }

    /// <summary>Gets when this attempt completed, or <see langword="null"/> if it is still running.</summary>
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>Gets the error message if this attempt failed, or <see langword="null"/> on success.</summary>
    public string? ErrorMessage { get; init; }

    /// <summary>Gets the per-phase timing records for this attempt.</summary>
    public IReadOnlyList<PhaseTiming> PhaseTimings { get; init; } = [];

    /// <summary>Gets when this attempt began.</summary>
    public DateTimeOffset StartedAt { get; init; }

    /// <summary>Gets the terminal status of this attempt.</summary>
    public JobStatus Status { get; init; }
}
