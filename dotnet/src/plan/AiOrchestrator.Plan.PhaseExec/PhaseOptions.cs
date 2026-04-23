// <copyright file="PhaseOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>Tunable options for the <see cref="PhaseExecutor"/>.</summary>
public sealed record PhaseOptions
{
    /// <summary>Gets the cap on auto-heal attempts per job (HEAL-RESUME-3). Default is 3.</summary>
    public int MaxAutoHealAttempts { get; init; } = 3;

    /// <summary>Gets the timeout for the MergeForwardIntegration phase. Default 15 minutes.</summary>
    public TimeSpan MergeFiTimeout { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>Gets the timeout for the Setup phase. Default 5 minutes.</summary>
    public TimeSpan SetupTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Gets the timeout for the Prechecks phase. Default 10 minutes.</summary>
    public TimeSpan PrechecksTimeout { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>Gets the timeout for the Work phase. Default 30 minutes.</summary>
    public TimeSpan WorkTimeout { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>Gets the timeout for the Commit phase. Default 5 minutes.</summary>
    public TimeSpan CommitTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Gets the timeout for the Postchecks phase. Default 10 minutes.</summary>
    public TimeSpan PostchecksTimeout { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>Gets the timeout for the MergeReverseIntegration phase. Default 15 minutes.</summary>
    public TimeSpan MergeRiTimeout { get; init; } = TimeSpan.FromMinutes(15);

    /// <summary>Gets the cap on phase-resume attempts for transient failures. Default 3.</summary>
    public int MaxPhaseResumeAttempts { get; init; } = 3;
}
