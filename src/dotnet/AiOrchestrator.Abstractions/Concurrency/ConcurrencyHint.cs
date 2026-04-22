// <copyright file="ConcurrencyHint.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Abstractions.Concurrency;

/// <summary>Provides scheduling hints used by the concurrency broker when admitting work.</summary>
public sealed record ConcurrencyHint
{
    /// <summary>Gets the plan that owns the work to be admitted.</summary>
    public required PlanId PlanId { get; init; }

    /// <summary>Gets the job that owns the work to be admitted.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets an optional estimate of the memory footprint, in megabytes.</summary>
    public int? FootprintMb { get; init; }
}
