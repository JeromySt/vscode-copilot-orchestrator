// <copyright file="TrustedPlugin.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;

namespace AiOrchestrator.Plugins.Trust;

/// <summary>
/// An individual entry in the trust file (TRUST-ACL-3), gating one specific plugin assembly.
/// A discovered plugin is rejected unless its plugin ID, assembly SHA-256, and author key
/// fingerprint match an entry here.
/// </summary>
public sealed record TrustedPlugin
{
    /// <summary>Gets the plugin identifier that this trust entry covers.</summary>
    [JsonPropertyName("pluginId")]
    public required string PluginId { get; init; }

    /// <summary>Gets the expected SHA-256 hex digest of the plugin assembly bytes.</summary>
    [JsonPropertyName("assemblySha256")]
    public required string AssemblySha256 { get; init; }

    /// <summary>Gets the expected author public key fingerprint (SHA-256 of the Ed25519 public key, hex).</summary>
    [JsonPropertyName("authorPublicKeyFingerprint")]
    public required string AuthorPublicKeyFingerprint { get; init; }

    /// <summary>Gets the maximum acceptable version of this plugin (inclusive).</summary>
    [JsonPropertyName("maxAcceptableVersion")]
    public required string MaxAcceptableVersion { get; init; }
}
