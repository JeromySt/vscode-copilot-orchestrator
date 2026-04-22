// <copyright file="CompositionRoot.Diagnose.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Diagnose;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the diagnose-bundle exporter (job 037).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="Diagnoser"/> and binds <see cref="DiagnoseOptions"/> from the
    /// <c>Diagnose</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddDiagnose(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<DiagnoseOptions>();
        _ = services.AddSingleton<Diagnoser>();

        // Internal sealed components owned by Diagnoser:
        // Pseudonymizer, MappingTable, MappingTableEncryptor.
        return services;
    }
}
