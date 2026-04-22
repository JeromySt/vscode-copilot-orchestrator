// <copyright file="CompactJsonFormatter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using AiOrchestrator.Abstractions.Redaction;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Logging;

/// <summary>
/// A <see cref="ConsoleFormatter"/> that emits each log entry as a single line of valid UTF-8 JSON.
/// All string-valued properties are passed through <see cref="IRedactor.Redact"/> before writing.
/// Ambient correlation context (<see cref="AmbientContext"/>) and the current
/// <see cref="Activity"/> trace/span IDs are included automatically.
/// On formatter failure, a fallback <c>LoggerFormatterFailure</c> JSON line is written and
/// the exception is rethrown (INV-8).
/// </summary>
public sealed class CompactJsonFormatter : ConsoleFormatter, IDisposable
{
    /// <summary>The registered formatter name used when wiring up the console logger.</summary>
    public const string FormatterName = "compact-json";

    private readonly IRedactor redactor;
    private readonly IDisposable? optionsReloadToken;
    private CompactJsonFormatterOptions currentOptions;

    /// <summary>
    /// Initializes a new instance of the <see cref="CompactJsonFormatter"/> class.
    /// </summary>
    /// <param name="options">Monitor that provides current formatter options and change notifications.</param>
    /// <param name="redactor">Redactor applied to every string-valued property before write.</param>
    public CompactJsonFormatter(
        IOptionsMonitor<CompactJsonFormatterOptions> options,
        IRedactor redactor)
        : base(FormatterName)
    {
        this.redactor = redactor;
        this.currentOptions = options.CurrentValue;
        this.optionsReloadToken = options.OnChange(updated => this.currentOptions = updated);
    }

    /// <inheritdoc/>
    public override void Write<TState>(
        in LogEntry<TState> entry,
        IExternalScopeProvider? scopes,
        TextWriter writer)
    {
        try
        {
            this.WriteCore(in entry, scopes, writer);
        }
#pragma warning disable CA1031 // Do not catch general exception types — fallback required by INV-8
        catch (Exception ex)
        {
            WriteFallback(writer, ex);
            throw;
        }
#pragma warning restore CA1031
    }

    /// <inheritdoc/>
    public void Dispose() => this.optionsReloadToken?.Dispose();

    private static void WriteFallback(TextWriter writer, Exception ex)
    {
        var typeName = ex.GetType().Name.Replace("\"", "'", StringComparison.Ordinal);
        writer.Write($"{{\"level\":\"Error\",\"message\":\"LoggerFormatterFailure\",\"error\":\"{typeName}\"}}");
        writer.Write('\n');
    }

    private static string MapLogLevel(LogLevel level) => level switch
    {
        LogLevel.Trace => "Trace",
        LogLevel.Debug => "Debug",
        LogLevel.Information => "Information",
        LogLevel.Warning => "Warning",
        LogLevel.Error => "Error",
        LogLevel.Critical => "Critical",
        _ => "None",
    };

    private void WriteCore<TState>(
        in LogEntry<TState> entry,
        IExternalScopeProvider? scopes,
        TextWriter writer)
    {
        var options = this.currentOptions;

        using var buffer = new MemoryStream();
        using var jsonWriter = new Utf8JsonWriter(
            buffer,
            new JsonWriterOptions { Indented = options.IndentJson, SkipValidation = false });

        jsonWriter.WriteStartObject();

        jsonWriter.WriteString("timestamp", DateTimeOffset.UtcNow.ToString("o"));
        jsonWriter.WriteString("level", MapLogLevel(entry.LogLevel));
        jsonWriter.WriteString("category", entry.Category);

        var message = entry.Formatter(entry.State, entry.Exception);
        jsonWriter.WriteString("message", this.redactor.Redact(message));

        if (entry.Exception is not null)
        {
            jsonWriter.WriteString("exception", this.redactor.Redact(entry.Exception.ToString()));
        }

        // Activity-based traceId / spanId (INV-2)
        var activity = Activity.Current;
        if (activity is not null)
        {
            jsonWriter.WriteString("traceId", activity.TraceId.ToString());
            jsonWriter.WriteString("spanId", activity.SpanId.ToString());
        }

        // Ambient context (INV-3: redact all string values)
        foreach (var kvp in AmbientContext.Snapshot())
        {
            jsonWriter.WriteString(kvp.Key, this.redactor.Redact(kvp.Value?.ToString() ?? string.Empty));
        }

        // Scopes
        if (options.IncludeScopes && scopes is not null)
        {
            scopes.ForEachScope(
                (scope, jw) =>
                {
                    if (scope is IEnumerable<KeyValuePair<string, object?>> properties)
                    {
                        foreach (var prop in properties)
                        {
                            jw.WriteString(prop.Key, this.redactor.Redact(prop.Value?.ToString() ?? string.Empty));
                        }
                    }
                },
                jsonWriter);
        }

        jsonWriter.WriteEndObject();
        jsonWriter.Flush();

        var json = Encoding.UTF8.GetString(buffer.ToArray());
        writer.Write(json);
        writer.Write('\n');
    }
}
