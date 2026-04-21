// <copyright file="SystemDelayProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Time;

/// <summary>
/// Production implementation of <see cref="IDelayProvider"/> that delegates to
/// <see cref="Task.Delay(TimeSpan, TimeProvider, CancellationToken)"/>.
/// Use this in place of <c>Thread.Sleep</c>.
/// </summary>
public sealed class SystemDelayProvider : IDelayProvider
{
    private readonly TimeProvider underlying;

    /// <summary>Initializes a new instance of the <see cref="SystemDelayProvider"/> class.</summary>
    /// <param name="underlying">
    /// The <see cref="TimeProvider"/> used to drive the delay.
    /// Defaults to <see cref="TimeProvider.System"/> when <see langword="null"/>.
    /// </param>
    public SystemDelayProvider(TimeProvider? underlying = null)
    {
        this.underlying = underlying ?? TimeProvider.System;
    }

    /// <inheritdoc />
    public ValueTask Delay(TimeSpan delay, CancellationToken ct)
    {
        return new ValueTask(Task.Delay(delay, this.underlying, ct));
    }
}
