// <copyright file="HsmSignature.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Daemon.Update;

#pragma warning disable CA1819 // Properties should not return arrays — record carries raw signature bytes by design.

/// <summary>One HSM-produced signature contributing to the M-of-N quorum.</summary>
public sealed record HsmSignature
{
    /// <summary>Gets the identifier of the HSM key that produced the signature.</summary>
    public required string KeyId { get; init; }

    /// <summary>Gets the raw 64-byte Ed25519 signature.</summary>
    public required byte[] Signature { get; init; }
}

#pragma warning restore CA1819
