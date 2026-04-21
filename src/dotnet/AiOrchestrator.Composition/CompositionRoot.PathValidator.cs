// <copyright file="CompositionRoot.PathValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.PathValidator.Paths;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>
/// Extension methods for registering path validation services.
/// </summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the <see cref="IPathValidator"/> service with the given allowed root directories.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <param name="allowedRoots">The set of allowed root directories for path validation.</param>
    /// <returns>The updated service collection.</returns>
    public static IServiceCollection AddPathValidator(
        this IServiceCollection services,
        IEnumerable<string> allowedRoots)
    {
        if (services == null)
        {
            throw new ArgumentNullException(nameof(services));
        }

        if (allowedRoots == null)
        {
            throw new ArgumentNullException(nameof(allowedRoots));
        }

        return services.AddSingleton<IPathValidator>(
            new DefaultPathValidator(allowedRoots));
    }
}
