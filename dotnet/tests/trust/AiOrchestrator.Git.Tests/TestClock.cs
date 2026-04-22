// <copyright file="TestClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Git.Tests;

/// <summary>Deterministic test clock.</summary>
internal sealed class TestClock : IClock
{
    /// <summary>Gets or sets the time returned by <see cref="UtcNow"/>.</summary>
    public DateTimeOffset Now { get; set; } = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>Gets or sets the monotonic counter.</summary>
    public long Mono { get; set; }

    /// <inheritdoc/>
    public DateTimeOffset UtcNow => this.Now;

    /// <inheritdoc/>
    public long MonotonicMilliseconds => this.Mono;
}
