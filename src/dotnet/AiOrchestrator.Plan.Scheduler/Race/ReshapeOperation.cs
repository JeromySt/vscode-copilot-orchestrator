// <copyright file="ReshapeOperation.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.Scheduler.Race;

/// <summary>Describes the kind of reshape applied to a plan.</summary>
public enum ReshapeKind
{
    /// <summary>A new job node was added to the plan.</summary>
    AddJob,

    /// <summary>An existing job node was removed from the plan.</summary>
    RemoveJob,
}

/// <summary>
/// Represents a reshape mutation applied to a plan's DAG structure — either adding or removing a job node.
/// The <see cref="T22T14Resolver"/> uses pending reshape operations to recompute snapshot-validation dependencies.
/// </summary>
public sealed record ReshapeOperation
{
    /// <summary>Gets the kind of reshape (add or remove).</summary>
    public required ReshapeKind Kind { get; init; }

    /// <summary>Gets the job node being added or removed.</summary>
    public required JobNode Job { get; init; }
}
