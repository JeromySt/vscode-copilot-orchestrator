// <copyright file="TrustedAuditPubKey.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.SkewManifest;

/// <summary>Declares a trusted audit-log signing key with a validity window.</summary>
public sealed record TrustedAuditPubKey
{
    /// <summary>Gets the stable identifier for this key.</summary>
    public required string KeyId { get; init; }

    /// <summary>Gets the raw Ed25519 public key bytes.</summary>
    public required byte[] PublicKey { get; init; }

    /// <summary>Gets the instant before which the key must not be accepted.</summary>
    public required DateTimeOffset NotValidBefore { get; init; }

    /// <summary>Gets the instant after which the key must not be accepted.</summary>
    public required DateTimeOffset NotValidAfter { get; init; }

    /// <summary>Gets an optional revocation reason; non-null implies revoked.</summary>
    public required string? RevocationReason { get; init; }
}
