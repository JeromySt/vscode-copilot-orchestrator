// <copyright file="ReshapeResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>Result of a single atomic <see cref="PlanReshaper.ApplyAsync"/> call.</summary>
public sealed record ReshapeResult
{
    /// <summary>Gets the per-operation results, in input order.</summary>
    public required ImmutableArray<OperationResult> PerOperation { get; init; }

    /// <summary>Gets the plan state after all operations were applied.</summary>
    public required AiOrchestrator.Plan.Models.Plan UpdatedPlan { get; init; }
}
