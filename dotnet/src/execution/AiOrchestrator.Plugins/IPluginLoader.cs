// <copyright file="IPluginLoader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Plugins;

/// <summary>
/// Loads and manages third-party plugin assemblies from a configured directory,
/// using <c>AssemblyLoadContext</c> isolation (INV-6).  Implementations enforce
/// TRUST-ACL-* invariants, version compatibility, and capability declarations.
/// </summary>
public interface IPluginLoader
{
    /// <summary>Gets the plugins that are currently loaded.</summary>
    IReadOnlyList<LoadedPlugin> Loaded { get; }

    /// <summary>
    /// Discovers all plugin subdirectories under <see cref="PluginOptions.PluginRoot"/>,
    /// validates each against the trust file (TRUST-ACL-*) and manifest (INV-4, INV-5),
    /// loads the assembly into an isolated <see cref="Loading.PluginLoadContext"/> (INV-6),
    /// and records declared capabilities (INV-7).
    /// </summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The array of successfully loaded plugins.</returns>
    ValueTask<ImmutableArray<LoadedPlugin>> DiscoverAndLoadAsync(CancellationToken ct);

    /// <summary>
    /// Unloads a previously loaded plugin, releasing its <see cref="Loading.PluginLoadContext"/>
    /// so that the GC can reclaim the assembly (INV-6).
    /// </summary>
    /// <param name="plugin">The plugin to unload.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the plugin has been unloaded.</returns>
    ValueTask UnloadAsync(LoadedPlugin plugin, CancellationToken ct);
}
