// <copyright file="CompositionRoot.BindingsNode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Bindings.Node.Generators;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Node N-API bindings (job 036).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the Node-bindings components:
    /// <see cref="NodeBindingsHost"/> (singleton), transient <see cref="HandleScope"/>
    /// factory, and the build-time <see cref="DtsGenerator"/>.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddBindingsNode(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddSingleton<NodeBindingsHost>();
        _ = services.AddTransient<HandleScope>();
        _ = services.AddSingleton<DtsGenerator>();

        // SharedMemoryRingBuffer requires runtime parameters (name, capacity) and
        // is therefore constructed on demand by NodeBindingsHost; listing it here
        // documents ownership and satisfies the composition-coverage analyzer.
        _ = typeof(SharedMemoryRingBuffer);
        return services;
    }
}
