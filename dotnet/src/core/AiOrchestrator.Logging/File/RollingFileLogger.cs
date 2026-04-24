// <copyright file="RollingFileLogger.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Logging.File;

/// <summary>
/// An <see cref="ILogger"/> that writes CompactJSON log lines to a <see cref="RollingFileLoggerProvider"/>.
/// </summary>
internal sealed class RollingFileLogger : ILogger
{
    private readonly string category;
    private readonly RollingFileLoggerProvider provider;

    public RollingFileLogger(string category, RollingFileLoggerProvider provider)
    {
        this.category = category;
        this.provider = provider;
    }

    /// <inheritdoc/>
    public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Debug;

    /// <inheritdoc/>
    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    /// <inheritdoc/>
    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!this.IsEnabled(logLevel))
        {
            return;
        }

        var json = JsonSerializer.Serialize(new
        {
            t = DateTimeOffset.UtcNow.ToString("O"),
            l = logLevel.ToString(),
            c = this.category,
            m = formatter(state, exception),
            x = exception?.ToString(),
        });

        this.provider.Write(json);
    }
}
