// <copyright file="OtlpTelemetrySink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.Diagnostics.Metrics;
using AiOrchestrator.Abstractions.Telemetry;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Logging.Telemetry;

/// <summary>
/// An <see cref="ITelemetrySink"/> backed by OpenTelemetry-compatible
/// <see cref="System.Diagnostics.Metrics.Meter"/> and <see cref="ActivitySource"/> primitives.
/// When <see cref="OtlpOptions.Enabled"/> is <c>false</c>, all methods are zero-allocation no-ops (INV-6).
/// Tag dictionaries are copied defensively before being handed to the OTel APIs (INV-7).
/// </summary>
public sealed class OtlpTelemetrySink : ITelemetrySink, IDisposable
{
    private const string InstrumentationName = "AiOrchestrator";
    private const string InstrumentationVersion = "1.0.0";

    private readonly OtlpOptions options;
    private readonly Meter? meter;
    private readonly ActivitySource? activitySource;

    /// <summary>
    /// Initializes a new instance of the <see cref="OtlpTelemetrySink"/> class.
    /// If <see cref="OtlpOptions.Enabled"/> is <c>false</c>, no resources are allocated.
    /// </summary>
    /// <param name="options">The OTLP configuration options.</param>
    public OtlpTelemetrySink(IOptions<OtlpOptions> options)
    {
        this.options = options.Value;
        if (this.options.Enabled)
        {
            this.meter = new Meter(InstrumentationName, InstrumentationVersion);
            this.activitySource = new ActivitySource(InstrumentationName, InstrumentationVersion);
        }
    }

    /// <inheritdoc/>
    public void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null)
    {
        if (!this.options.Enabled)
        {
            return;
        }

        var counter = this.meter!.CreateCounter<long>(name);
        counter.Add(delta, BuildTagList(tags));
    }

    /// <inheritdoc/>
    public void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null)
    {
        if (!this.options.Enabled)
        {
            return;
        }

        var histogram = this.meter!.CreateHistogram<double>(name);
        histogram.Record(value, BuildTagList(tags));
    }

    /// <inheritdoc/>
    public IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null)
    {
        if (!this.options.Enabled)
        {
            return NullDisposable.Instance;
        }

        // Defensively copy the tags dictionary before handing to OTel (INV-7)
        var tagsCopy = tags is null
            ? null
            : new Dictionary<string, object>(tags, StringComparer.Ordinal);

        var activity = this.activitySource!.StartActivity(name);
        if (activity is not null && tagsCopy is not null)
        {
            foreach (var tag in tagsCopy)
            {
                _ = activity.SetTag(tag.Key, tag.Value);
            }
        }

        return (IDisposable?)activity ?? NullDisposable.Instance;
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        this.meter?.Dispose();
        this.activitySource?.Dispose();
    }

    private static TagList BuildTagList(IReadOnlyDictionary<string, object>? tags)
    {
        // Defensively copy the tags before use (INV-7).
        // TagList is a value type so no heap allocation for the list itself.
        var tagList = default(TagList);
        if (tags is null)
        {
            return tagList;
        }

        foreach (var kvp in tags)
        {
            tagList.Add(kvp.Key, kvp.Value);
        }

        return tagList;
    }

    private sealed class NullDisposable : IDisposable
    {
        internal static readonly NullDisposable Instance = new();

        private NullDisposable()
        {
        }

        public void Dispose()
        {
        }
    }
}
