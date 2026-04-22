// <copyright file="AgentStats.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Agent;

/// <summary>Aggregated token / turn / cost statistics for a single agent run (INV-5).</summary>
public sealed record AgentStats
{
    /// <summary>Gets the total input tokens consumed.</summary>
    public required int InputTokens { get; init; }

    /// <summary>Gets the total output tokens produced.</summary>
    public required int OutputTokens { get; init; }

    /// <summary>Gets the number of agent turns observed.</summary>
    public required int Turns { get; init; }

    /// <summary>Gets the estimated cost in USD, if the runner reports it.</summary>
    public required decimal? EstimatedCostUsd { get; init; }

    /// <summary>Gets the raw provider-reported counters (e.g. cache tokens) keyed by provider-specific name.</summary>
    public required ImmutableDictionary<string, long> ProviderRaw { get; init; }

    /// <summary>Gets an empty statistics record suitable as a parser fallback (INV-5).</summary>
    /// <returns>An <see cref="AgentStats"/> with all counters zeroed.</returns>
    public static AgentStats Empty() => new()
    {
        InputTokens = 0,
        OutputTokens = 0,
        Turns = 0,
        EstimatedCostUsd = null,
        ProviderRaw = ImmutableDictionary<string, long>.Empty,
    };
}
