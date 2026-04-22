// <copyright file="CompositionRoot.Redaction.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using AiOrchestrator.Abstractions.Redaction;
using AiOrchestrator.Redaction;
using AiOrchestrator.Redaction.Detectors;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root partial class — redaction registrations.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the default <see cref="RedactorPipeline"/> as the <see cref="IRedactor"/>
    /// implementation, pre-populated with all built-in secret detectors (T3-RED-1 through
    /// T3-RED-7 and P-SID-2).
    /// </summary>
    /// <param name="services">The service collection to add registrations to.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddRedaction(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        _ = services.AddSingleton<IRedactor>(static _ =>
        {
            IReadOnlyList<ISecretDetector> detectors =
            [
                new GitHubPatDetector(),
                new AwsAccessKeyDetector(),
                new ApiKeyDetector(),
                new ConnectionStringDetector(),
                new SshPrivateKeyDetector(),
                new GenericSecretDetector(),
                new JwtDetector(),
                new PathSidDetector(),
            ];

            return new RedactorPipeline(detectors);
        });

        return services;
    }
}
