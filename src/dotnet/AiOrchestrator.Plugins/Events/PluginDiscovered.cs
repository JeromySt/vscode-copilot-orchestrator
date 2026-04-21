// <copyright file="PluginDiscovered.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>Published when the <see cref="PluginLoader"/> discovers a plugin directory during scanning (INV-9).</summary>
public sealed record PluginDiscovered
{
    /// <summary>Gets the unique identifier of the discovered plugin.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the SHA-256 hex digest of the plugin assembly.</summary>
    public required string AssemblySha256 { get; init; }

    /// <summary>Gets the UTC timestamp of discovery.</summary>
    public required DateTimeOffset DiscoveredAt { get; init; }
}
