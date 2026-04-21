// <copyright file="InMemoryClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.TestKit.Time;

/// <summary>
/// A controllable, in-memory implementation of <see cref="IClock"/> for use in unit tests.
/// Time does not advance automatically; call <see cref="Advance"/> or <see cref="SetUtcNow"/>
/// to move the clock forward (or backward, to simulate regression scenarios).
/// </summary>
public sealed class InMemoryClock : IClock
{
    private DateTimeOffset utcNow;
    private long monotonicMs;

    /// <summary>
    /// Initializes a new instance of the <see cref="InMemoryClock"/> class.
    /// </summary>
    /// <param name="utcNow">
    /// The initial wall-clock value. Defaults to <see cref="DateTimeOffset.UtcNow"/> if <see langword="null"/>.
    /// </param>
    /// <param name="monotonicMs">The initial monotonic millisecond counter. Defaults to <c>0</c>.</param>
    public InMemoryClock(DateTimeOffset? utcNow = null, long monotonicMs = 0)
    {
        this.utcNow = (utcNow ?? DateTimeOffset.UtcNow).ToUniversalTime();
        this.monotonicMs = monotonicMs;
    }

    /// <inheritdoc />
    public DateTimeOffset UtcNow => this.utcNow;

    /// <inheritdoc />
    public long MonotonicMilliseconds => this.monotonicMs;

    /// <summary>Advances both the wall clock and the monotonic counter by the specified duration.</summary>
    /// <param name="delta">The amount of time to advance the clock.</param>
    public void Advance(TimeSpan delta)
    {
        this.utcNow = this.utcNow.Add(delta);
        this.monotonicMs += (long)delta.TotalMilliseconds;
    }

    /// <summary>Explicitly sets the wall-clock value, without affecting the monotonic counter.</summary>
    /// <param name="value">The new UTC wall-clock value.</param>
    public void SetUtcNow(DateTimeOffset value)
    {
        this.utcNow = value.ToUniversalTime();
    }

    /// <summary>
    /// Explicitly sets the monotonic millisecond counter.
    /// Can be used to simulate a clock regression by passing a value less than the current reading.
    /// </summary>
    /// <param name="value">The new monotonic counter value in milliseconds.</param>
    public void SetMonotonicMs(long value)
    {
        this.monotonicMs = value;
    }
}
