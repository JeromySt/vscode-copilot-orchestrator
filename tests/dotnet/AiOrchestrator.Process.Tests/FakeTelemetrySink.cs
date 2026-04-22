// <copyright file="FakeTelemetrySink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Telemetry;

namespace AiOrchestrator.Process.Tests;

/// <summary>In-memory implementation of <see cref="ITelemetrySink"/> that records calls for test assertions.</summary>
internal sealed class FakeTelemetrySink : ITelemetrySink
{
    private readonly List<(string Name, long Delta)> _counters = [];
    private readonly List<(string Name, double Value)> _histograms = [];

    /// <summary>Gets all recorded counter increments.</summary>
    public IReadOnlyList<(string Name, long Delta)> Counters => _counters;

    /// <summary>Gets all recorded histogram values.</summary>
    public IReadOnlyList<(string Name, double Value)> Histograms => _histograms;

    /// <inheritdoc/>
    public void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null)
        => _counters.Add((name, delta));

    /// <inheritdoc/>
    public void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null)
        => _histograms.Add((name, value));

    /// <inheritdoc/>
    public IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null)
        => new NoOpDisposable();

    private sealed class NoOpDisposable : IDisposable
    {
        public void Dispose() { }
    }
}
