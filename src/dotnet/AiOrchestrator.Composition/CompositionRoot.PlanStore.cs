// <copyright file="CompositionRoot.PlanStore.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the durable plan store subsystem (job 028).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="PlanStore"/> as the implementation of <see cref="IPlanStore"/>
    /// and binds <see cref="PlanStoreOptions"/> from the <c>PlanStore</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddPlanStore(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<PlanStoreOptions>();
        _ = services.AddSingleton<IPlanStore, PlanStore>();

        // Internal sealed components owned by PlanStore:
        // PlanJournal, PlanCheckpointer, PlanState, MutationApplier, MutationJson.
        return services;
    }
}
