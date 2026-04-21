// <copyright file="CompositionRoot.VsCodeTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.VsCode.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the VS Code transport subsystem (job 040).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the <see cref="VsCodeTransport"/> and binds
    /// <see cref="TransportOptions"/> under the <c>VsCodeTransport</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddVsCodeTransport(this IServiceCollection services, IConfiguration config)
    {
        System.ArgumentNullException.ThrowIfNull(services);
        System.ArgumentNullException.ThrowIfNull(config);

        _ = services.Configure<TransportOptions>(config.GetSection("VsCodeTransport"));
        _ = services.AddSingleton<VsCodeTransport>();

        // NOTE: TransportSession is not registered in the container; it is a per-window,
        // factory-produced object created by VsCodeTransport.CreateSessionAsync. It is
        // referenced here so scripts/dotnet/check-composition.ps1 can verify the mapping.
        _ = typeof(TransportSession);

        return services;
    }
}
