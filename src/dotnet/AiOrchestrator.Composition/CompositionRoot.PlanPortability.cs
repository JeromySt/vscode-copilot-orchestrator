// <copyright file="CompositionRoot.PlanPortability.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.Portability;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for plan portability (export/import, job 038).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="PlanExporter"/> and <see cref="PlanImporter"/> and binds
    /// <see cref="PortabilityOptions"/> from the <c>PlanPortability</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddPlanPortability(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<PortabilityOptions>();
        _ = services.AddSingleton<PlanExporter>();
        _ = services.AddSingleton<PlanImporter>();

        return services;
    }
}
