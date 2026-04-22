// <copyright file="TestClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.WorktreeLease.Tests;

/// <summary>Deterministic test clock.</summary>
internal sealed class TestClock : IClock
{
    public DateTimeOffset Now { get; set; } = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public long Mono { get; set; }

    public DateTimeOffset UtcNow => this.Now;

    public long MonotonicMilliseconds => this.Mono;
}

/// <summary>Clock backed by real system time — used by tests that need wall-clock semantics (e.g. contention races).</summary>
internal sealed class RealClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

    public long MonotonicMilliseconds => Environment.TickCount64;
}
