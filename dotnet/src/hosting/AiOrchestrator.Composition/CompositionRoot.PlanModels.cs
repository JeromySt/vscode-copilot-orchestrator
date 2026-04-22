// <copyright file="CompositionRoot.PlanModels.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.Models;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Plan.Models subsystem.</summary>
public static partial class CompositionRoot
{
    /// <summary>Registers <see cref="IPlanSerializer"/> and related plan-model services.</summary>
    /// <param name="services">The service collection to register into.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddPlanModels(this IServiceCollection services)
    {
        return services.AddSingleton<IPlanSerializer, DefaultPlanSerializer>();
    }
}
