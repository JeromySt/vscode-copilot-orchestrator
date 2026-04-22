// <copyright file="TrustFile.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Plugins.Trust;

/// <summary>
/// Represents the deserialized content of the trust file (INV-2, TRUST-ACL-*).
/// The trust file is Ed25519-signed by an authorized operator; the signature covers the
/// JSON-serialized content with the <c>ed25519Signature</c> field omitted.
/// </summary>
public sealed record TrustFile
{
    /// <summary>Gets the list of trusted plugins that are allowed to be loaded.</summary>
    [JsonPropertyName("trustedPlugins")]
    public required ImmutableArray<TrustedPlugin> TrustedPlugins { get; init; }

    /// <summary>Gets the UTC timestamp when the trust file was signed.</summary>
    [JsonPropertyName("signedAt")]
    public required DateTimeOffset SignedAt { get; init; }

    /// <summary>Gets the raw 64-byte Ed25519 signature over the canonical payload.</summary>
    [JsonPropertyName("ed25519Signature")]
    public required byte[] Ed25519Signature { get; init; }

    /// <summary>Gets the key identifier of the signer (for key rotation support).</summary>
    [JsonPropertyName("signerKeyId")]
    public required string SignerKeyId { get; init; }
}
