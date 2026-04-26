// <copyright file="CompositionRoot.ConcurrencyBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.Broker;
using AiOrchestrator.Concurrency.Broker.Fairness;
using AiOrchestrator.Concurrency.Broker.Rpc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the <c>AiOrchestrator.Concurrency.Broker</c> layer.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the host concurrency broker services:
    /// <list type="bullet">
    ///   <item><see cref="HostConcurrencyBrokerDaemon"/> as an <see cref="IHostedService"/>.</item>
    ///   <item><see cref="HostConcurrencyBrokerClient"/> as <see cref="IHostConcurrencyBrokerClient"/>.</item>
    ///   <item><see cref="FairnessScheduler"/> as an internal singleton.</item>
    ///   <item>Platform-appropriate <see cref="IRpcServer"/> (UDS on Linux/macOS, named pipe on Windows).</item>
    /// </list>
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <see cref="IServiceCollection"/> for chaining.</returns>
    public static IServiceCollection AddHostConcurrencyBroker(this IServiceCollection services)
    {
        // HostAdmission is a value object (admission token) returned by AcquireAsync — not a DI-registered service.
        return services
            .AddOptions<BrokerOptions>()
            .Services
            .AddSingleton<FairnessScheduler>(sp => new FairnessScheduler(
                sp.GetRequiredService<IClock>(),
                sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<BrokerOptions>>(),
                sp.GetRequiredService<IEventBus>()))
            .AddSingleton<IRpcServer>(sp =>
            {
                if (OperatingSystem.IsWindows())
                {
                    return new NamedPipeRpcServer(
                        sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<BrokerOptions>>(),
                        sp.GetRequiredService<FairnessScheduler>(),
                        sp.GetRequiredService<ILogger<NamedPipeRpcServer>>());
                }

                return new UnixSocketRpcServer(
                    sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<BrokerOptions>>(),
                    sp.GetRequiredService<FairnessScheduler>(),
                    sp.GetRequiredService<IFileSystem>(),
                    sp.GetRequiredService<ILogger<UnixSocketRpcServer>>());
            })
            .AddSingleton<HostConcurrencyBrokerDaemon>(sp => new HostConcurrencyBrokerDaemon(
                sp.GetRequiredService<IRpcServer>(),
                sp.GetRequiredService<FairnessScheduler>(),
                sp.GetRequiredService<IClock>(),
                sp.GetRequiredService<IEventBus>(),
                sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<BrokerOptions>>(),
                sp.GetRequiredService<ILogger<HostConcurrencyBrokerDaemon>>()))
            .AddSingleton<IHostedService>(sp => sp.GetRequiredService<HostConcurrencyBrokerDaemon>())
            .AddSingleton<IHostConcurrencyBrokerClient>(sp => new HostConcurrencyBrokerClient(
                sp.GetRequiredService<HostConcurrencyBrokerDaemon>(),
                sp.GetRequiredService<ILogger<HostConcurrencyBrokerClient>>()));
    }
}
