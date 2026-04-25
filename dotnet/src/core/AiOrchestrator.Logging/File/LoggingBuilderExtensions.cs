// <copyright file="LoggingBuilderExtensions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Logging.File;

/// <summary>
/// Extension methods for adding rolling file logging to <see cref="ILoggingBuilder"/>.
/// </summary>
[ExcludeFromCodeCoverage]
public static class LoggingBuilderExtensions
{
    /// <summary>Adds a rolling file logger to the logging pipeline.</summary>
    /// <param name="builder">The logging builder to configure.</param>
    /// <param name="options">Options controlling file path, size, and retention.</param>
    /// <returns>The <paramref name="builder"/> for chaining.</returns>
    public static ILoggingBuilder AddRollingFile(
        this ILoggingBuilder builder,
        RollingFileLoggerOptions options)
    {
        builder.AddProvider(new RollingFileLoggerProvider(options));
        return builder;
    }
}
