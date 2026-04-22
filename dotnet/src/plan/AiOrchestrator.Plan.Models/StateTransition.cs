// <copyright file="StateTransition.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Models;

/// <summary>Records a single status transition for a job node.</summary>
public sealed record StateTransition
{
    /// <summary>Gets the status the job transitioned from.</summary>
    public JobStatus From { get; init; }

    /// <summary>Gets when this transition occurred.</summary>
    public DateTimeOffset OccurredAt { get; init; }

    /// <summary>Gets an optional human-readable reason describing why the transition happened.</summary>
    public string? Reason { get; init; }

    /// <summary>Gets the status the job transitioned to.</summary>
    public JobStatus To { get; init; }
}
