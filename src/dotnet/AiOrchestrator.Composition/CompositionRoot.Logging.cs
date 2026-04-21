// <copyright file="CompositionRoot.Logging.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Logging;
using AiOrchestrator.Logging.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the Logging subsystem.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the <see cref="CompactJsonFormatter"/>, ambient context, and
    /// <see cref="OtlpTelemetrySink"/> with the dependency injection container.
    /// Options are bound from the <c>Logging:CompactJson</c> and <c>Otlp</c>
    /// configuration sections.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddLogging(this IServiceCollection services, IConfiguration config)
    {
        _ = services.AddLogging(builder =>
        {
            _ = builder.AddConsole(o => o.FormatterName = CompactJsonFormatter.FormatterName);
            _ = builder.AddConsoleFormatter<CompactJsonFormatter, CompactJsonFormatterOptions>();
        });

        _ = services.Configure<CompactJsonFormatterOptions>(config.GetSection("Logging:CompactJson"));
        _ = services.Configure<OtlpOptions>(config.GetSection("Otlp"));
        _ = services.AddSingleton<ITelemetrySink, OtlpTelemetrySink>();

        return services;
    }
}
