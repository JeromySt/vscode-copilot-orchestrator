// <copyright file="PluginManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Plugins;

/// <summary>
/// Deserialized content of the <c>manifest.json</c> file found in each plugin subdirectory.
/// All fields are required; a missing or malformed manifest causes the plugin to be rejected (INV-4).
/// </summary>
public sealed record PluginManifest
{
    /// <summary>Gets the unique identifier for this plugin.</summary>
    [JsonPropertyName("pluginId")]
    public required string PluginId { get; init; }

    /// <summary>Gets the plugin's version string (e.g., <c>"1.2.3"</c>).</summary>
    [JsonPropertyName("pluginVersion")]
    public required string PluginVersion { get; init; }

    /// <summary>Gets the minimum host version this plugin is compatible with (inclusive).</summary>
    [JsonPropertyName("minHostVersion")]
    public required string MinHostVersion { get; init; }

    /// <summary>Gets the maximum host version this plugin is compatible with (inclusive).</summary>
    [JsonPropertyName("maxHostVersion")]
    public required string MaxHostVersion { get; init; }

    /// <summary>Gets the capabilities that the plugin requires, as string names of <see cref="PluginCapability"/> values.</summary>
    [JsonPropertyName("capabilities")]
    public ImmutableArray<string> Capabilities { get; init; } = [];

    /// <summary>Gets the file name of the primary plugin assembly (e.g., <c>"MyPlugin.dll"</c>).</summary>
    [JsonPropertyName("assemblyFileName")]
    public required string AssemblyFileName { get; init; }

    /// <summary>Gets the author's public key fingerprint (SHA-256 of the Ed25519 public key, hex).</summary>
    [JsonPropertyName("authorPublicKeyFingerprint")]
    public required string AuthorPublicKeyFingerprint { get; init; }
}
