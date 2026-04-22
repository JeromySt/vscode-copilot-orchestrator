// <copyright file="CompositionRoot.Git.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Git;
using AiOrchestrator.Git;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the <c>AiOrchestrator.Git</c> module.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="IGitOperations"/> backed by <see cref="GitOperations"/>.
    /// LibGit2Sharp is permitted only inside this assembly (J18-PC-3).
    /// </summary>
    /// <param name="services">The DI service collection.</param>
    /// <returns>The same <paramref name="services"/> for chaining.</returns>
    public static IServiceCollection AddGit(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        _ = services.AddOptions<GitOptions>();
        _ = services.AddSingleton<GitOperations>();
        _ = services.AddSingleton<IGitOperations>(static sp => sp.GetRequiredService<GitOperations>());
        return services;
    }
}
