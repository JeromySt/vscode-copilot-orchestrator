// <copyright file="RegressionReport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Benchmarks;

/// <summary>Aggregate output of <see cref="SloRegressionGate"/>.</summary>
public sealed record RegressionReport
{
    /// <summary>Gets the list of regressions detected.</summary>
    public required ImmutableArray<RegressionFinding> Regressions { get; init; }

    /// <summary>Gets a value indicating whether the gate passed (no regressions).</summary>
    public bool Ok => this.Regressions.IsEmpty;
}
