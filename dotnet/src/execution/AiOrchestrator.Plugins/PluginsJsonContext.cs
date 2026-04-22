// <copyright file="PluginsJsonContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text.Json.Serialization;
using AiOrchestrator.Plugins.Trust;

namespace AiOrchestrator.Plugins;

/// <summary>Source-generated JSON serialization context for the Plugins subsystem.</summary>
[JsonSerializable(typeof(TrustFile))]
[JsonSerializable(typeof(TrustedPlugin))]
[JsonSerializable(typeof(PluginManifest))]
[JsonSerializable(typeof(CanonicalTrustPayload))]
[JsonSerializable(typeof(ImmutableArray<TrustedPlugin>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = false)]
internal sealed partial class PluginsJsonContext : JsonSerializerContext
{
}
