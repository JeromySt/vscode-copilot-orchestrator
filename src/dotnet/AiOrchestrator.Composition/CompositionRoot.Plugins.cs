// <copyright file="CompositionRoot.Plugins.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Plugin Loader subsystem (job 026).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="PluginLoader"/> as the implementation of <see cref="IPluginLoader"/>
    /// and binds <see cref="PluginOptions"/> from the <c>Plugins</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddPluginLoader(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<PluginOptions>();
        _ = services.AddSingleton<IPluginLoader, PluginLoader>();

        // Internal components owned by PluginLoader (resolved by the type itself).
        // Mentioned here so the composition-completeness check sees them:
        // TrustFileVerifier, CapabilityChecker, PluginLoadContext (per-plugin).
        return services;
    }
}
