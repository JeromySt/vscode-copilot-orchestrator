// <copyright file="IPluginLoader.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.Plugins;

/// <summary>
/// Loads and unloads plugin assemblies from a directory. Implementations are
/// expected to use isolated load contexts so plugins can be unloaded without
/// process restart.
/// </summary>
public interface IPluginLoader
{
    /// <summary>Discovers and loads all plugins beneath the given directory.</summary>
    /// <param name="pluginDirectory">The absolute path to the directory containing plugin manifests.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The plugins that were successfully loaded.</returns>
    ValueTask<IReadOnlyList<LoadedPlugin>> LoadAllAsync(AbsolutePath pluginDirectory, CancellationToken ct);

    /// <summary>Unloads a previously loaded plugin and releases its load context.</summary>
    /// <param name="plugin">The plugin to unload.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the plugin has been unloaded.</returns>
    ValueTask UnloadAsync(LoadedPlugin plugin, CancellationToken ct);
}
