// <copyright file="ImportOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Portability;

/// <summary>Per-request options that control how an archive is materialized.</summary>
public sealed record ImportOptions
{
    /// <summary>Gets an optional new plan name to apply on import.</summary>
    public string? OverridePlanName { get; init; }

    /// <summary>Gets an optional target branch override used by downstream execution engines.</summary>
    public string? OverrideTargetBranch { get; init; }

    /// <summary>Gets the policy applied when the archived plan id collides with an existing plan in the store (PORT-5).</summary>
    public ImportConflictPolicy IfPlanIdExists { get; init; } = ImportConflictPolicy.GenerateNewId;
}
