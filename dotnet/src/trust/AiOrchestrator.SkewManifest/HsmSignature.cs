// <copyright file="HsmSignature.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.SkewManifest;

/// <summary>A detached signature produced by a specific HSM over the manifest payload.</summary>
public sealed record HsmSignature
{
    /// <summary>Gets the HSM identifier; must match an entry in the configured burn-in set.</summary>
    public required string HsmId { get; init; }

    /// <summary>Gets the detached signature bytes.</summary>
    public required byte[] Signature { get; init; }

    /// <summary>Gets the signature algorithm name; currently always "Ed25519".</summary>
    public required string Algorithm { get; init; }
}
