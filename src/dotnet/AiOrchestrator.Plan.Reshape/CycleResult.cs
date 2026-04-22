// <copyright file="CycleResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>Result of a cycle-detection probe.</summary>
public sealed record CycleResult
{
    /// <summary>Gets a value indicating whether applying the operation would produce a cycle.</summary>
    public required bool Cycle { get; init; }

    /// <summary>
    /// Gets the witness cycle (an ordered list of job ids forming the loop) when
    /// <see cref="Cycle"/> is true. May be empty when job ids cannot be mapped to
    /// <see cref="JobId"/> (e.g., free-form string ids).
    /// </summary>
    public required ImmutableArray<JobId>? Cycle_ { get; init; }
}
