// <copyright file="CompositionRoot.Eventing.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Eventing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Eventing subsystem.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the in-process <see cref="EventBus"/> as <see cref="IEventBus"/> with the DI
    /// container. Binds <see cref="EventBusOptions"/> from the <c>Eventing</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddEventing(this IServiceCollection services, IConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        _ = services.Configure<EventBusOptions>(config.GetSection("Eventing"));
        _ = services.AddSingleton<EventBus>();
        _ = services.AddSingleton<IEventBus>(sp => sp.GetRequiredService<EventBus>());

        return services;
    }
}
