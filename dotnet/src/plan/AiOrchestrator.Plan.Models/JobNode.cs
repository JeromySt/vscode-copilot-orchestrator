// <copyright file="JobNode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace AiOrchestrator.Plan.Models;

/// <summary>Represents a single node in the plan DAG, encapsulating one unit of agent work.</summary>
public sealed record JobNode
{
    /// <summary>Gets the execution attempts made for this node, in chronological order.</summary>
    public IReadOnlyList<JobAttempt> Attempts { get; init; } = [];

    /// <summary>Gets when this job finished (succeeded, failed, or was canceled), or <see langword="null"/> if still running.</summary>
    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>Gets the IDs of jobs that must complete before this job can start.</summary>
    public IReadOnlyList<string> DependsOn { get; init; } = [];

    /// <summary>Gets the unique identifier for this job node.</summary>
    public string Id { get; init; } = string.Empty;

    /// <summary>Gets when this job began executing, or <see langword="null"/> if it has not yet started.</summary>
    public DateTimeOffset? StartedAt { get; init; }

    /// <summary>Gets the current execution status of this job.</summary>
    public JobStatus Status { get; init; }

    /// <summary>Gets the human-readable title of this job.</summary>
    public string Title { get; init; } = string.Empty;

    /// <summary>Gets the state-transition history for this job node.</summary>
    public IReadOnlyList<StateTransition> Transitions { get; init; } = [];

    /// <summary>Gets the work specification describing what the agent should do.</summary>
    public WorkSpec? WorkSpec { get; init; }
}
