// <copyright file="ResolutionResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using PlanRecord = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Scheduler.Race;

/// <summary>The result of a T22/T14 race-rule resolution pass.</summary>
public sealed record ResolutionResult
{
    /// <summary>Gets the plan with updated snapshot-validation dependency edges.</summary>
    public required PlanRecord AdjustedPlan { get; init; }

    /// <summary>Gets the new dependency edges wired from each leaf job to the snapshot-validation node.</summary>
    public required ImmutableArray<JobEdge> SvDependencyEdges { get; init; }
}
