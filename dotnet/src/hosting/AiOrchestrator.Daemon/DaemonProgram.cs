// <copyright file="DaemonProgram.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Daemon;

/// <summary>Entry point for the long-running AiOrchestrator daemon.</summary>
public sealed class DaemonProgram
{
    /// <summary>Process entry point.</summary>
    /// <param name="args">Command-line arguments.</param>
    /// <returns>Process exit code.</returns>
    public static async Task<int> Main(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        using var host = BuildHost(args);
        await host.RunAsync().ConfigureAwait(false);
        return 0;
    }

    /// <summary>Builds the generic host for the daemon.</summary>
    /// <param name="args">Command-line arguments.</param>
    /// <returns>The configured <see cref="IHost"/>.</returns>
    public static IHost BuildHost(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        return Host.CreateDefaultBuilder(args)
            .ConfigureServices((_, services) => services.AddDaemon())
            .Build();
    }
}
