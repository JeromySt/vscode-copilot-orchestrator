// <copyright file="BundleEntry.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Diagnose;

/// <summary>Metadata for a single entry inside the <c>.aiodiag</c> archive.</summary>
public sealed record BundleEntry
{
    /// <summary>Gets the entry's path (relative to archive root).</summary>
    public required string Path { get; init; }

    /// <summary>Gets the uncompressed size of the entry in bytes.</summary>
    public required long Bytes { get; init; }

    /// <summary>Gets the lowercase hex SHA-256 of the entry's uncompressed bytes.</summary>
    public required string Sha256 { get; init; }
}
