// <copyright file="KeyTransition.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit.Trust;

/// <summary>Describes a rotation from one Ed25519 audit-signing key to a new one (KEY-ROT-1).</summary>
public sealed class KeyTransition
{
    /// <summary>Gets the human-readable identifier of the retiring key.</summary>
    public required string OldKeyId { get; init; }

    /// <summary>Gets the human-readable identifier of the replacement key.</summary>
    public required string NewKeyId { get; init; }

    /// <summary>Gets the 32-byte Ed25519 public key of the retiring key.</summary>
    public required byte[] OldPubKey { get; init; }

    /// <summary>Gets the 32-byte Ed25519 public key of the replacement key.</summary>
    public required byte[] NewPubKey { get; init; }

    /// <summary>
    /// Gets the signature of the transition message produced by the OLD key.
    /// Combined with <see cref="NewKeySignature"/>, forms the cross-signature pair that
    /// <see cref="ChainVerifier"/> requires (INV-3).
    /// </summary>
    public required byte[] OldKeySignature { get; init; }

    /// <summary>Gets the signature of the transition message produced by the NEW key.</summary>
    public required byte[] NewKeySignature { get; init; }

    /// <summary>Gets the wall-clock instant at which the transition occurred.</summary>
    public required DateTimeOffset At { get; init; }

    /// <summary>Gets the reason the rotation was performed.</summary>
    public required TransitionReason Reason { get; init; }
}

/// <summary>The reason a <see cref="KeyTransition"/> was issued.</summary>
public enum TransitionReason
{
    /// <summary>Routine rotation per the configured key-lifetime policy.</summary>
    ScheduledRotation,

    /// <summary>The retiring key was known or suspected to be compromised.</summary>
    Compromise,

    /// <summary>The retiring key reached its expiration date.</summary>
    KeyExpiration,

    /// <summary>An emergency revocation triggered by an out-of-band signal.</summary>
    EmergencyRevocation,
}
