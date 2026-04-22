// <copyright file="InstallAnchor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit.Trust;

/// <summary>
/// The install-time trust anchor (TRUST-ROOT-1). The very first audit segment must be
/// signed by <see cref="InitialAuditPubKey"/>; all subsequent trust derives from this
/// public key through key transitions and release manifests.
/// </summary>
public sealed class InstallAnchor
{
    /// <summary>Gets the 32-byte Ed25519 public key established at install time.</summary>
    public required byte[] InitialAuditPubKey { get; init; }

    /// <summary>Gets the wall-clock instant at which the install anchor was created.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets the unique identifier for this install (used to scope multi-install hosts).</summary>
    public required string InstallId { get; init; }

    /// <summary>Gets the human-readable identifier of <see cref="InitialAuditPubKey"/>.</summary>
    public required string InitialAuditKeyId { get; init; }
}
