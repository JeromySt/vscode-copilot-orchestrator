// <copyright file="ITelemetrySink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Telemetry;

/// <summary>
/// Sink for counters, histograms, and activities. Implementations adapt to
/// OpenTelemetry, in-memory recorders for tests, or no-op for hot paths.
/// </summary>
public interface ITelemetrySink
{
    /// <summary>Records a delta against a named counter.</summary>
    /// <param name="name">The counter name (dot-separated convention).</param>
    /// <param name="delta">The amount to add to the counter.</param>
    /// <param name="tags">Optional dimensional tags.</param>
    void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null);

    /// <summary>Records a value against a named histogram.</summary>
    /// <param name="name">The histogram name.</param>
    /// <param name="value">The value to record.</param>
    /// <param name="tags">Optional dimensional tags.</param>
    void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null);

    /// <summary>Begins a tracing activity. Dispose the returned scope to end it.</summary>
    /// <param name="name">The activity name.</param>
    /// <param name="tags">Optional initial tags for the activity.</param>
    /// <returns>A disposable representing the active span.</returns>
    IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null);
}
