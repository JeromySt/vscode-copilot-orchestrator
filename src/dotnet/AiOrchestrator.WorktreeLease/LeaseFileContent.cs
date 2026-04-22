// <copyright file="LeaseFileContent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.WorktreeLease;

/// <summary>On-disk JSON representation of a lease file (INV-8: SchemaVersion="1").</summary>
public sealed record LeaseFileContent
{
    /// <summary>Gets the current fencing token.</summary>
    public required FencingToken Token { get; init; }

    /// <summary>Gets the holder principal's user name.</summary>
    public required string HolderUserName { get; init; }

    /// <summary>Gets a stable hash of the holder process identity.</summary>
    public required string HolderProcessHash { get; init; }

    /// <summary>Gets the UTC time at which the lease was acquired or last renewed.</summary>
    public required DateTimeOffset AcquiredAt { get; init; }

    /// <summary>Gets the UTC time at which the lease expires.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets the lease schema version string. Only <c>"1"</c> is accepted.</summary>
    public required string SchemaVersion { get; init; }
}
