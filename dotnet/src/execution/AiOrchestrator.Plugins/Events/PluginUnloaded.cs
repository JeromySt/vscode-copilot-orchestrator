// <copyright file="PluginUnloaded.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins.Events;

/// <summary>Published when a plugin is unloaded from its isolated context (INV-9).</summary>
public sealed record PluginUnloaded
{
    /// <summary>Gets the unique identifier of the unloaded plugin.</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the SHA-256 hex digest of the plugin assembly.</summary>
    public required string AssemblySha256 { get; init; }

    /// <summary>Gets the UTC timestamp of unloading.</summary>
    public required DateTimeOffset UnloadedAt { get; init; }
}
