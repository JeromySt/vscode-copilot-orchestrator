// <copyright file="SkewManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.SkewManifest;

/// <summary>
/// Signed manifest describing the trusted audit-log signing keys that the daemon
/// will accept at any given point in time (spec §3.31.1.5 / §3.31.2.6).
/// </summary>
public sealed record SkewManifest
{
    /// <summary>Gets the schema version of the manifest payload.</summary>
    public required Version SchemaVersion { get; init; }

    /// <summary>Gets the manifest version; monotonically increasing across manifests (INV-6).</summary>
    public required Version ManifestVersion { get; init; }

    /// <summary>Gets the wall-clock time at which the manifest was signed.</summary>
    public required DateTimeOffset SignedAt { get; init; }

    /// <summary>Gets the instant after which the manifest is considered expired.</summary>
    public required DateTimeOffset NotValidAfter { get; init; }

    /// <summary>Gets the set of trusted audit public keys carried by the manifest.</summary>
    public required ImmutableArray<TrustedAuditPubKey> TrustedAuditPubKeys { get; init; }

    /// <summary>Gets the HSM detached signatures over the canonical payload (M-of-N).</summary>
    public required ImmutableArray<HsmSignature> HsmSignatures { get; init; }

    /// <summary>Gets the emergency revocation block, if any.</summary>
    public required EmergencyRevocation? EmergencyRevocation { get; init; }

    /// <summary>Gets the transparency-log inclusion proof, if any (Sigstore-style).</summary>
    public required string? TransparencyLogProof { get; init; }
}
