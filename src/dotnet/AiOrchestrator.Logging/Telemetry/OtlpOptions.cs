// <copyright file="OtlpOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Logging.Telemetry;

/// <summary>
/// Configuration options for <see cref="OtlpTelemetrySink"/>.
/// </summary>
public sealed record OtlpOptions
{
    /// <summary>Gets the OTLP exporter endpoint URL, or <c>null</c> to use the default.</summary>
    public string? Endpoint { get; init; }

    /// <summary>
    /// Gets a value indicating whether the OTLP sink is enabled.
    /// When <c>false</c>, all recording methods are zero-allocation no-ops.
    /// Defaults to <c>false</c>.
    /// </summary>
    public bool Enabled { get; init; }

    /// <summary>Gets the metric export interval. Defaults to 10 seconds.</summary>
    public TimeSpan ExportInterval { get; init; } = TimeSpan.FromSeconds(10);
}
