// <copyright file="CompositionRoot.Shell.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Shell;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the <c>AiOrchestrator.Shell</c> module.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="IShellRunner"/> as a singleton, along with the default
    /// <see cref="ShellOptions"/>. Requires <c>AddProcess</c>, <c>AddTime</c>, the
    /// filesystem abstraction, and the event bus to already be registered.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddShell(this IServiceCollection services)
    {
        _ = services.AddOptions<ShellOptions>();
        _ = services.AddSingleton<IShellRunner, ShellRunner>();
        return services;
    }
}
