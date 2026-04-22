// <copyright file="SignedReleaseManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace AiOrchestrator.Daemon.Update;

/// <summary>A release manifest carrying artifacts plus an M-of-N HSM signature quorum.</summary>
public sealed record SignedReleaseManifest
{
    /// <summary>Gets the version this manifest publishes.</summary>
    public required Version Version { get; init; }

    /// <summary>Gets the artifacts to download for this release.</summary>
    public required ImmutableArray<DaemonArtifact> Artifacts { get; init; }

    /// <summary>Gets the wall-clock instant at which the manifest was signed.</summary>
    public required DateTimeOffset SignedAt { get; init; }

    /// <summary>Gets the HSM signatures produced by the offline ceremony.</summary>
    public required ImmutableArray<HsmSignature> Signatures { get; init; }

    /// <summary>Gets the minimum installed version that may transition to <see cref="Version"/>.</summary>
    public required Version MinSupportedVersion { get; init; }

    /// <summary>Gets the trusted Ed25519 audit public keys for this release.</summary>
    public required ImmutableArray<byte[]> TrustedAuditPubKeys { get; init; }
}
