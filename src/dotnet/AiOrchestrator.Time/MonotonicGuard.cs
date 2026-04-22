// <copyright file="MonotonicGuard.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Time;

/// <summary>
/// Wraps an <see cref="IClock"/> and panics if the monotonic counter ever regresses,
/// surfacing hardware or VM clock bugs before they silently corrupt timing logic.
/// </summary>
public sealed class MonotonicGuard : IClock
{
    private readonly IClock inner;
    private readonly ITelemetrySink telemetry;
    private readonly object syncRoot = new();
    private long lastMonotonicMs;

    /// <summary>
    /// Initializes a new instance of the <see cref="MonotonicGuard"/> class.
    /// </summary>
    /// <param name="inner">The underlying clock whose monotonic counter is guarded.</param>
    /// <param name="telemetry">Sink used to emit the <c>MonotonicClockRegression</c> counter on regression.</param>
    public MonotonicGuard(IClock inner, ITelemetrySink telemetry)
    {
        this.inner = inner;
        this.telemetry = telemetry;
    }

    /// <inheritdoc />
    public DateTimeOffset UtcNow => this.inner.UtcNow;

    /// <inheritdoc />
    /// <exception cref="MonotonicRegressionException">
    /// Thrown when the inner clock reports a value less than the previously observed value.
    /// </exception>
    public long MonotonicMilliseconds
    {
        get
        {
            var current = this.inner.MonotonicMilliseconds;

            lock (this.syncRoot)
            {
                if (current < this.lastMonotonicMs)
                {
                    this.telemetry.RecordCounter("MonotonicClockRegression", 1);
                    throw new MonotonicRegressionException(this.lastMonotonicMs, current);
                }

                this.lastMonotonicMs = current;
            }

            return current;
        }
    }
}
