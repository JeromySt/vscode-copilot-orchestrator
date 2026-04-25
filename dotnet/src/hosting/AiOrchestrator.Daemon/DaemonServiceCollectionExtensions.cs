// <copyright file="DaemonServiceCollectionExtensions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using AiOrchestrator.Daemon.PidFile;
using AiOrchestrator.Daemon.Update;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Daemon;

/// <summary>
/// Service-collection extensions registering the daemon update controller (job 034).
/// Internal sealed components: <see cref="ReleaseManifestFetcher"/>, <see cref="StagedSwap"/>,
/// <see cref="HealthCheck"/>, <see cref="PidFileWriter"/>.
/// </summary>
[ExcludeFromCodeCoverage]
public static class DaemonServiceCollectionExtensions
{
    /// <summary>Registers <see cref="UpdateController"/> and its collaborators.</summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddDaemon(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<DaemonOptions>();
        _ = services.AddHttpClient();

        _ = services.AddSingleton<ReleaseManifestFetcher>();
        _ = services.AddSingleton<StagedSwap>();
        _ = services.AddSingleton<HealthCheck>();
        _ = services.AddSingleton<PidFileWriter>();

        _ = services.AddSingleton<UpdateController>(sp => new UpdateController(
            sp.GetRequiredService<System.Net.Http.IHttpClientFactory>(),
            sp.GetRequiredService<AiOrchestrator.Abstractions.Io.IFileSystem>(),
            sp.GetRequiredService<AiOrchestrator.Abstractions.Time.IClock>(),
            sp.GetRequiredService<AiOrchestrator.Audit.IAuditLog>(),
            sp.GetRequiredService<AiOrchestrator.Abstractions.Eventing.IEventBus>(),
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<DaemonOptions>>(),
            sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<UpdateController>>(),
            sp.GetRequiredService<ReleaseManifestFetcher>(),
            sp.GetRequiredService<StagedSwap>(),
            sp.GetRequiredService<HealthCheck>()));
        _ = services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<UpdateController>());

        return services;
    }
}
