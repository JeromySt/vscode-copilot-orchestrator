// <copyright file="EmergencyRevocation.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.SkewManifest;

/// <summary>
/// Emergency revocation of one or more <see cref="TrustedAuditPubKey.KeyId"/>s, carried
/// on the manifest and additionally signed by the separate emergency HSM set (INV-7).
/// </summary>
public sealed record EmergencyRevocation
{
    /// <summary>Gets the identifiers of keys being revoked.</summary>
    public required ImmutableArray<string> RevokedKeyIds { get; init; }

    /// <summary>Gets a human-readable reason for the revocation.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the instant at which the revocation took effect.</summary>
    public required DateTimeOffset RevokedAt { get; init; }

    /// <summary>Gets the M-of-N signatures from the emergency HSM set authorizing this revocation.</summary>
    public required ImmutableArray<HsmSignature> AdditionalSignatures { get; init; }
}
