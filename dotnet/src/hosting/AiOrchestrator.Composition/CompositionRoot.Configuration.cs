// <copyright file="CompositionRoot.Configuration.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Configuration;
using AiOrchestrator.Configuration.Options;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using IConfigurationProvider = AiOrchestrator.Abstractions.Configuration.IConfigurationProvider;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the configuration layer.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers all strongly-typed options and the <see cref="IConfigurationProvider" />
    /// implementation that wraps the given layered <see cref="IConfiguration" />.
    /// </summary>
    /// <param name="services">The service collection to extend.</param>
    /// <param name="root">The fully layered configuration root.</param>
    /// <returns>The same <paramref name="services" /> for chaining.</returns>
    public static IServiceCollection AddConfiguration(
        this IServiceCollection services,
        IConfiguration root)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(root);

        _ = services.AddOptions<SchedulerOptions>()
            .BindConfiguration("Scheduler")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddOptions<EventLogOptions>()
            .BindConfiguration("EventLog")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddOptions<PlanOptions>()
            .BindConfiguration("Plan")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddOptions<ConcurrencyOptions>()
            .BindConfiguration("Concurrency")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddOptions<BuildKeysOptions>()
            .BindConfiguration("BuildKeys")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddOptions<DiagnoseOptions>()
            .BindConfiguration("Diagnose")
            .ValidateDataAnnotations()
            .ValidateOnStart();

        _ = services.AddSingleton<IConfigurationProvider>(
            _ => new LayeredConfigurationProvider(root));

        return services;
    }
}
