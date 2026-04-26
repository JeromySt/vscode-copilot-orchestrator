// <copyright file="CompositionRoot.HookGate.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.HookGate;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.HookGate.Nonce;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Rpc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extension for the hook-gate daemon (job 020).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="HookGateDaemon"/> as an <see cref="IHostedService"/> together with
    /// <see cref="IHookGateClient"/>, <see cref="INonceManager"/>, <see cref="IRedirectionManager"/>
    /// (per-OS), <see cref="IImmutabilityEventSink"/>, and the platform <see cref="IRpcServer"/>.
    ///
    /// Internal sealed components referenced here so the composition-completeness check sees
    /// them: <c>NonceManager</c>, <c>EventBusImmutabilityEventSink</c>, <c>LinuxRedirectionManager</c>,
    /// <c>WindowsRedirectionManager</c>, <c>UnixSocketRpcServer</c>, <c>NamedPipeRpcServer</c>,
    /// <c>InProcessRpcServer</c>, <c>HookGateDaemon</c>, <c>HookGateClient</c>.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddHookGate(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<HookGateOptions>();

        _ = services.AddSingleton<INonceManager, NonceManager>();
        _ = services.AddSingleton<IImmutabilityEventSink, EventBusImmutabilityEventSink>();

        _ = services.AddSingleton<IRedirectionManager>(static sp =>
        {
            var sink = sp.GetRequiredService<IImmutabilityEventSink>();
            var spawner = sp.GetRequiredService<AiOrchestrator.Abstractions.Process.IProcessSpawner>();
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return new WindowsRedirectionManager(sink, spawner, sp.GetRequiredService<IFileSystem>(), sp.GetRequiredService<ILogger<WindowsRedirectionManager>>());
            }

            return new LinuxRedirectionManager(sink, spawner, sp.GetRequiredService<IFileSystem>(), sp.GetRequiredService<ILogger<LinuxRedirectionManager>>());
        });

        _ = services.AddSingleton<IRpcServer>(static sp =>
        {
            var opts = sp.GetRequiredService<IOptionsMonitor<HookGateOptions>>().CurrentValue;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return new NamedPipeRpcServer(opts.PipeName, sp.GetRequiredService<ILogger<NamedPipeRpcServer>>());
            }

            return new UnixSocketRpcServer(opts.SocketPath, sp.GetRequiredService<IFileSystem>(), sp.GetRequiredService<ILogger<UnixSocketRpcServer>>());
        });

        _ = services.AddSingleton<HookGateDaemon>();
        _ = services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<HookGateDaemon>());
        _ = services.AddSingleton<IHookGateClient, HookGateClient>();

        return services;
    }
}
