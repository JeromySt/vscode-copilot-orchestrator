// <copyright file="PluginLoadContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Reflection;
using System.Runtime.Loader;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Plugins.Loading;

/// <summary>
/// An isolated <see cref="AssemblyLoadContext"/> for a single plugin (INV-6).
/// The context is always created with <c>isCollectible: true</c> so that
/// <see cref="PluginLoader.UnloadAsync"/> can trigger GC reclaim of the
/// plugin's types and assemblies.
/// </summary>
internal sealed class PluginLoadContext : AssemblyLoadContext
{
    private readonly string pluginDirectory;

    /// <summary>Initializes a new instance of the <see cref="PluginLoadContext"/> class.</summary>
    /// <param name="assemblyPath">Absolute path to the plugin's primary assembly.</param>
    /// <param name="isCollectible">
    /// When <see langword="true"/> (the production default), the context can be unloaded.
    /// Pass <see langword="false"/> only in tests that verify non-collectible behaviour.
    /// </param>
    public PluginLoadContext(AbsolutePath assemblyPath, bool isCollectible = true)
        : base(name: $"plugin:{assemblyPath.Value}", isCollectible: isCollectible)
    {
        this.pluginDirectory = Path.GetDirectoryName(assemblyPath.Value)
            ?? throw new ArgumentException("Assembly path has no directory.", nameof(assemblyPath));
    }

    /// <summary>
    /// Resolves assemblies from the plugin's own directory first, falling back to the
    /// default load context for host framework assemblies.  Plugin assemblies are NEVER
    /// resolved from the default context, ensuring type isolation (INV-6).
    /// </summary>
    /// <param name="assemblyName">The assembly name to resolve.</param>
    /// <returns>The resolved <see cref="Assembly"/>, or <see langword="null"/> to fall back to the default context.</returns>
    protected override Assembly? Load(AssemblyName assemblyName)
    {
        // Look for the assembly in the plugin directory.
        var candidate = Path.Combine(this.pluginDirectory, assemblyName.Name + ".dll");
        if (File.Exists(candidate))
        {
            return this.LoadFromAssemblyPath(candidate);
        }

        // Return null to let the runtime fall back to the default ALC (host assemblies).
        return null;
    }
}
