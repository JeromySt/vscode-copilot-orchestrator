// <copyright file="FakeClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Shell.Tests.Fakes;

/// <summary>Manually-advanceable clock for deterministic duration measurement.</summary>
public sealed class FakeClock : IClock
{
    private long monotonicMs;

    /// <summary>Gets or sets the current UTC time.</summary>
    public DateTimeOffset Now { get; set; } = new(2025, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <inheritdoc/>
    public DateTimeOffset UtcNow => this.Now;

    /// <inheritdoc/>
    public long MonotonicMilliseconds => System.Threading.Interlocked.Read(ref this.monotonicMs);

    /// <summary>Advances the monotonic counter.</summary>
    /// <param name="delta">Amount to advance by.</param>
    public void Advance(TimeSpan delta)
    {
        _ = System.Threading.Interlocked.Add(ref this.monotonicMs, (long)delta.TotalMilliseconds);
        this.Now = this.Now.Add(delta);
    }
}
