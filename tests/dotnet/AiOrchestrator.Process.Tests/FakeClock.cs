// <copyright file="FakeClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Process.Tests;

/// <summary>In-memory implementation of <see cref="IClock"/> for tests.</summary>
internal sealed class FakeClock : IClock
{
    private long _monotonic;

    /// <inheritdoc/>
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    /// <inheritdoc/>
    public long MonotonicMilliseconds => System.Threading.Interlocked.Read(ref _monotonic);

    /// <summary>Advances the monotonic counter.</summary>
    /// <param name="ms">Milliseconds to advance.</param>
    public void Advance(long ms) => System.Threading.Interlocked.Add(ref _monotonic, ms);
}
