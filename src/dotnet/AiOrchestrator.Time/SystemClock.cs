// <copyright file="SystemClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Time;

/// <summary>
/// Production implementation of <see cref="IClock"/> that delegates to <see cref="TimeProvider.System"/>.
/// Use this in place of <c>DateTime.UtcNow</c> or <c>Environment.TickCount</c>.
/// </summary>
public sealed class SystemClock : IClock
{
    private readonly TimeProvider underlying;

    /// <summary>Initializes a new instance of the <see cref="SystemClock"/> class.</summary>
    /// <param name="underlying">
    /// The <see cref="TimeProvider"/> to delegate to.
    /// Defaults to <see cref="TimeProvider.System"/> when <see langword="null"/>.
    /// </param>
    public SystemClock(TimeProvider? underlying = null)
    {
        this.underlying = underlying ?? TimeProvider.System;
    }

    /// <inheritdoc />
    public DateTimeOffset UtcNow => this.underlying.GetUtcNow();

    /// <inheritdoc />
    public long MonotonicMilliseconds =>
        this.underlying.GetTimestamp() / (Stopwatch.Frequency / 1000);
}
