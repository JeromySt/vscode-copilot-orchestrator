// <copyright file="HostBuilderExtensions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using AiOrchestrator.Composition;
using AiOrchestrator.Hosting.Hosted;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Hosting;

/// <summary>
/// Extension methods for integrating AiOrchestrator into a .NET generic host or service collection.
/// </summary>
public static class HostBuilderExtensions
{
    /// <summary>
    /// Configures the <see cref="IHostBuilder"/> with the full AiOrchestrator service composition.
    /// </summary>
    /// <param name="builder">The host builder to configure.</param>
    /// <param name="configure">Optional action to customise <see cref="AiOrchestratorOptions"/>.</param>
    /// <returns>The same <paramref name="builder"/> instance for chaining.</returns>
    public static IHostBuilder UseAiOrchestrator(
        this IHostBuilder builder,
        Action<AiOrchestratorOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(builder);

        return builder.ConfigureServices((ctx, services) =>
        {
            var options = new AiOrchestratorOptions();
            configure?.Invoke(options);
            _ = AddAiOrchestrator(services, ctx.Configuration, options);
        });
    }

    /// <summary>
    /// Registers all AiOrchestrator services with default options.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> for chaining.</returns>
    public static IServiceCollection AddAiOrchestrator(
        this IServiceCollection services,
        IConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        return AddAiOrchestrator(services, config, new AiOrchestratorOptions());
    }

    internal static IServiceCollection AddAiOrchestrator(
        IServiceCollection services,
        IConfiguration config,
        AiOrchestratorOptions options)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(options);

        _ = services
            .AddTime()
            .AddFileSystem()
            .AddLogging(config)
            .AddEventing(config)
            .AddEventLog(config)
            .AddAuditLog()
            .AddPlanModels()
            .AddPlanStore()
            .AddConfiguration(config)
            .AddPathValidator(new List<string> { options.StoreRoot.Value });

        if (options.EnableHookGate)
        {
            _ = services.AddHostedService<HookGateDaemon>();
        }

        if (options.EnableConcurrencyBroker)
        {
            _ = services.AddHostedService<ConcurrencyBrokerService>();
        }

        if (options.EnablePluginLoader)
        {
            _ = services.AddHostedService<PlanSchedulerService>();
        }

        return services;
    }
}
