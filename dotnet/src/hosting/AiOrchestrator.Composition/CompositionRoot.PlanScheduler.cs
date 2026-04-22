// <copyright file="CompositionRoot.PlanScheduler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.Broker;
using AiOrchestrator.Concurrency.User;
using AiOrchestrator.Plan.Scheduler;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the <c>AiOrchestrator.Plan.Scheduler</c> layer.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the plan scheduler services:
    /// <list type="bullet">
    ///   <item><see cref="PlanScheduler"/> as an <see cref="IHostedService"/>.</item>
    /// </list>
    /// <para>
    /// Callers must register an <see cref="IPhaseExecutor"/> implementation before calling this method.
    /// The phase executor is provided by the <c>AiOrchestrator.Plan.PhaseExecutor</c> layer (job 031).
    /// </para>
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <see cref="IServiceCollection"/> for chaining.</returns>
    public static IServiceCollection AddPlanScheduler(this IServiceCollection services)
    {
        return services
            .AddOptions<SchedulerOptions>()
            .Services
            .AddSingleton<PlanScheduler>(sp => new PlanScheduler(
                sp.GetRequiredService<IPlanStore>(),
                sp.GetRequiredService<IPerUserConcurrency>(),
                sp.GetRequiredService<IHostConcurrencyBrokerClient>(),
                sp.GetRequiredService<IEventBus>(),
                sp.GetRequiredService<IClock>(),
                sp.GetRequiredService<IPhaseExecutor>(),
                sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<SchedulerOptions>>(),
                sp.GetRequiredService<ILogger<PlanScheduler>>()))
            .AddSingleton<IHostedService>(sp => sp.GetRequiredService<PlanScheduler>());
    }
}
