// <copyright file="SkewManifestVerification.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.SkewManifest;

/// <summary>Outcome of verifying a <see cref="SkewManifest"/>.</summary>
public sealed record SkewManifestVerification
{
    /// <summary>Gets a value indicating whether verification succeeded.</summary>
    public required bool Ok { get; init; }

    /// <summary>Gets the rejection reason when <see cref="Ok"/> is <see langword="false"/>.</summary>
    public required SkewManifestRejectionReason? Reason { get; init; }

    /// <summary>Gets a human-readable detail describing the outcome.</summary>
    public required string? Detail { get; init; }
}
