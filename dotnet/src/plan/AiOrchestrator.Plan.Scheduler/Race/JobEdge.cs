// <copyright file="JobEdge.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Scheduler.Race;

/// <summary>Represents a directed dependency edge in the plan DAG.</summary>
public sealed record JobEdge
{
    /// <summary>Gets the source job (the one that must complete first).</summary>
    public required JobId From { get; init; }

    /// <summary>Gets the target job (the one that depends on <see cref="From"/>).</summary>
    public required JobId To { get; init; }
}
