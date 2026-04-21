// <copyright file="MonotonicRegressionException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Time;

/// <summary>
/// Thrown by <see cref="MonotonicGuard"/> when the underlying clock reports a value
/// smaller than the previously observed monotonic timestamp, indicating a hardware
/// or virtual-machine clock anomaly.
/// </summary>
public sealed class MonotonicRegressionException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MonotonicRegressionException"/> class.
    /// </summary>
    /// <param name="previous">The last observed monotonic millisecond value.</param>
    /// <param name="current">The regressed monotonic millisecond value that triggered the exception.</param>
    public MonotonicRegressionException(long previous, long current)
        : base($"Monotonic clock regressed from {previous} ms to {current} ms — possible VM/hardware bug.")
    {
        this.Previous = previous;
        this.Current = current;
    }

    /// <summary>Gets the last-observed monotonic millisecond value before the regression was detected.</summary>
    public long Previous { get; }

    /// <summary>Gets the regressed monotonic millisecond value that triggered this exception.</summary>
    public long Current { get; }
}
