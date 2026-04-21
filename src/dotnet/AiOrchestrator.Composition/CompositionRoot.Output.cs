// <copyright file="CompositionRoot.Output.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Output;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Output (stream-redirector) subsystem.</summary>
public static partial class CompositionRoot
{
    /// <summary>Registers the <see cref="StreamRedirector"/> singleton and binds <see cref="RedirectorOptions"/>.</summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">Application configuration root; binds the <c>Output</c> section.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddOutput(this IServiceCollection services, IConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        _ = services.Configure<RedirectorOptions>(config.GetSection("Output"));
        _ = services.AddSingleton<StreamRedirector>();
        return services;
    }
}
