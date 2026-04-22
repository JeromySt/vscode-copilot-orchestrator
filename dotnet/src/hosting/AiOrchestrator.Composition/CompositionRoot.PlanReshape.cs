// <copyright file="CompositionRoot.PlanReshape.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.Reshape;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the plan reshape subsystem (job 029).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="PlanReshaper"/> as a singleton and binds
    /// <see cref="PlanReshapeOptions"/> from the <c>PlanReshape</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddPlanReshape(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<PlanReshapeOptions>();
        _ = services.AddSingleton<PlanReshaper>();
        return services;
    }
}
