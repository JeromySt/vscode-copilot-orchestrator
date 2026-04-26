// <copyright file="CompositionRoot.Process.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Process;
using AiOrchestrator.Process.Lifecycle;
using AiOrchestrator.Process.Pty;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the <c>AiOrchestrator.Process</c> module.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the process-spawning infrastructure including <see cref="IProcessSpawner"/>,
    /// <see cref="IProcessLifecycle"/> (crash-dump capture), and platform-appropriate
    /// <see cref="IPtyAllocator"/> implementation.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddProcess(this IServiceCollection services)
    {
        _ = services.AddSingleton<IProcessLifecycle, CrashDumpCollector>();
        _ = services.AddSingleton<IProcessSpawner, ProcessSpawner>();
        _ = services.AddSingleton<IProcessHandleRegistry, ProcessHandleRegistry>();
        _ = services.AddSingleton<IPtyAllocator>(static _ =>
            System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(
                System.Runtime.InteropServices.OSPlatform.Windows)
                ? new ConPtyAllocatorWindows()
                : new PtyAllocatorPosix());

        return services;
    }
}
