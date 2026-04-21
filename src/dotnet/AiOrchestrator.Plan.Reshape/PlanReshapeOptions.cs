// <copyright file="PlanReshapeOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Reshape;

/// <summary>Configuration options for <see cref="PlanReshaper"/>.</summary>
public sealed record PlanReshapeOptions
{
    /// <summary>Gets the maximum number of <see cref="ReshapeOperation"/> entries accepted per
    /// <see cref="PlanReshaper.ApplyAsync"/> call (INV-9 / RS-BATCH).</summary>
    public int MaxOpsPerCall { get; init; } = 100;

    /// <summary>
    /// Gets the plan-level cap on total job nodes.
    /// Enforced AT RESHAPE TIME per DAG-LIM-1. Defaults to <see cref="int.MaxValue"/>.
    /// </summary>
    public int MaxJobs { get; init; } = int.MaxValue;

    /// <summary>
    /// Gets the plan-level cap on parallel-ready (no-dependency) job nodes.
    /// Enforced AT RESHAPE TIME per DAG-LIM-1. Defaults to <see cref="int.MaxValue"/>.
    /// </summary>
    public int MaxParallel { get; init; } = int.MaxValue;
}
