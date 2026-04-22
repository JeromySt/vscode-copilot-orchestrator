// <copyright file="TestClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Real-time clock for tests (uses <see cref="System.Environment.TickCount64"/>).</summary>
internal sealed class TestClock : IClock
{
    private readonly DateTimeOffset start = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000);

    public DateTimeOffset UtcNow => this.start.AddMilliseconds(this.MonotonicMilliseconds);

    public long MonotonicMilliseconds => Environment.TickCount64;
}
