// <copyright file="ExportOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Portability;

/// <summary>Per-request options that control what is emitted in a plan export.</summary>
public sealed record ExportOptions
{
    /// <summary>Gets a value indicating whether attempt history is included (PORT-6). Defaults to <see langword="false"/> for privacy/size.</summary>
    public bool IncludeAttempts { get; init; }

    /// <summary>Gets a value indicating whether auxiliary artifact files referenced by jobs are included.</summary>
    public bool IncludeArtifacts { get; init; }

    /// <summary>Gets a value indicating whether absolute paths are redacted to repo-relative or <c>&lt;HOME&gt;/...</c> pseudo-paths (PORT-3).</summary>
    public bool RedactPaths { get; init; } = true;

    /// <summary>Gets a fixed timestamp used for the manifest; exposed for deterministic tests (see INV-7).</summary>
    public System.DateTimeOffset? OverrideCreatedAt { get; init; }
}
