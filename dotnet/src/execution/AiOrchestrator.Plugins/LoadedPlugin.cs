// <copyright file="LoadedPlugin.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plugins.Loading;

namespace AiOrchestrator.Plugins;

/// <summary>
/// Represents a plugin assembly that has been successfully loaded, trust-verified, and
/// capability-enumerated by <see cref="PluginLoader"/>.
/// </summary>
public sealed record LoadedPlugin
{
    /// <summary>Gets the unique identifier of the plugin (from its manifest).</summary>
    public required string PluginId { get; init; }

    /// <summary>Gets the plugin's version (from its manifest).</summary>
    public required Version PluginVersion { get; init; }

    /// <summary>Gets the absolute path to the plugin's primary assembly on disk.</summary>
    public required AbsolutePath AssemblyPath { get; init; }

    /// <summary>Gets the set of host capabilities declared by the plugin's exported types.</summary>
    public required ImmutableArray<PluginCapability> Capabilities { get; init; }

    /// <summary>Gets the exported public types from the plugin assembly.</summary>
    public required ImmutableArray<Type> ExportedTypes { get; init; }

    /// <summary>
    /// Gets the <see cref="PluginLoadContext"/> that owns this plugin's assembly load.
    /// Used by <see cref="PluginLoader.UnloadAsync"/> to trigger unloading.
    /// </summary>
    internal PluginLoadContext? Context { get; init; }
}
