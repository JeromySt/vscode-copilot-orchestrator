// <copyright file="PluginLoaded.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Plugins.Events;

/// <summary>Published when a plugin is successfully loaded into its isolated context (INV-9).</summary>
public sealed record PluginLoaded
{
    /// <summary>Gets the unique identifier of the loaded plugin.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the SHA-256 hex digest of the plugin assembly.</summary>
    public required string AssemblySha256 { get; init; }

    /// <summary>Gets the capabilities declared by the plugin.</summary>
    public required ImmutableArray<PluginCapability> Capabilities { get; init; }

    /// <summary>Gets the UTC timestamp of loading.</summary>
    public required DateTimeOffset LoadedAt { get; init; }
}
