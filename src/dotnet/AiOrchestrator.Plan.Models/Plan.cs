// <copyright file="Plan.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace AiOrchestrator.Plan.Models;

/// <summary>The top-level orchestration plan containing a DAG of job nodes.</summary>
public sealed record Plan
{
    /// <summary>Gets when this plan was created.</summary>
    public DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets an optional human-readable description of the plan's purpose.</summary>
    public string? Description { get; init; }

    /// <summary>Gets the unique identifier for this plan.</summary>
    public string Id { get; init; } = string.Empty;

    /// <summary>Gets the job nodes keyed by their <see cref="JobNode.Id"/>.</summary>
    public IReadOnlyDictionary<string, JobNode> Jobs { get; init; } = new Dictionary<string, JobNode>();

    /// <summary>Gets the human-readable name of the plan.</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>Gets when the plan began executing, or <see langword="null"/> if it has not yet started.</summary>
    public DateTimeOffset? StartedAt { get; init; }

    /// <summary>Gets the current lifecycle status of the plan.</summary>
    public PlanStatus Status { get; init; }
}
