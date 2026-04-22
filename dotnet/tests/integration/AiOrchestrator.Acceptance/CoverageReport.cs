// <copyright file="CoverageReport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Acceptance;

/// <summary>
/// Result of running the rule-id coverage gate. <see cref="Ok"/> is true when every named
/// rule id in §§3.27–3.33 of the design doc has at least one corresponding contract test.
/// </summary>
public sealed record CoverageReport
{
    /// <summary>Gets every rule id extracted from the design doc.</summary>
    public required ImmutableArray<string> AllRuleIds { get; init; }

    /// <summary>Gets the rule ids that have at least one matching <c>[ContractTest("...")]</c> attribute.</summary>
    public required ImmutableArray<string> CoveredRuleIds { get; init; }

    /// <summary>Gets the rule ids that are present in the doc but have no matching contract test.</summary>
    public required ImmutableArray<string> UncoveredRuleIds { get; init; }

    /// <summary>Gets contract-test ids for which no matching rule id exists in the doc.</summary>
    public required ImmutableArray<string> ExtraTestRuleIds { get; init; }

    /// <summary>Gets a value indicating whether the gate passes (every doc rule id is covered).</summary>
    public bool Ok => this.UncoveredRuleIds.IsEmpty;
}
