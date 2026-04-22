// <copyright file="TransparencyLogCheckResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.SkewManifest.Verification;

/// <summary>Outcome of a transparency-log inclusion check.</summary>
public sealed record TransparencyLogCheckResult
{
    /// <summary>Gets a value indicating whether the manifest was confirmed in the log.</summary>
    public required bool Included { get; init; }

    /// <summary>Gets an optional human-readable failure reason.</summary>
    public required string? FailureReason { get; init; }
}
