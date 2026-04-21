// <copyright file="ReleaseManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.Audit.Trust;

/// <summary>
/// A daemon-observed release manifest (TRUST-ROOT-2/4/7). Produced offline by jobs 39 + 43
/// and signed by an offline root. The daemon NEVER signs or modifies a manifest; it only
/// observes <c>release-manifest.signed.json</c> and emits <see cref="BuildKeyRolloverObserved"/>.
/// </summary>
public sealed class ReleaseManifest
{
    /// <summary>Gets the manifest version (e.g., <c>1.4.0</c>).</summary>
    public required Version Version { get; init; }

    /// <summary>Gets the trusted Ed25519 audit public keys for this release.</summary>
    public required ImmutableArray<byte[]> TrustedAuditPubKeys { get; init; }

    /// <summary>Gets the offline-root signature over the rest of the manifest.</summary>
    public required byte[] OfflineRootSignature { get; init; }

    /// <summary>Gets the wall-clock instant at which the manifest was signed.</summary>
    public required DateTimeOffset SignedAt { get; init; }
}

/// <summary>Daemon-emitted event recording observation of a new <see cref="ReleaseManifest"/> (INV-6).</summary>
public sealed class BuildKeyRolloverObserved
{
    /// <summary>Gets the manifest version that was observed.</summary>
    public required string ObservedManifestVersion { get; init; }

    /// <summary>Gets the SHA-256 fingerprint of the offline-root key that signed the manifest.</summary>
    public required byte[] ManifestSignerFingerprint { get; init; }

    /// <summary>Gets the wall-clock instant at which the daemon observed the manifest.</summary>
    public required DateTimeOffset At { get; init; }
}
