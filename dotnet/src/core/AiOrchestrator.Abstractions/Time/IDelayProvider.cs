// <copyright file="IDelayProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Time;

/// <summary>
/// Provides an asynchronous delay that can be substituted in tests to avoid real waiting.
/// </summary>
public interface IDelayProvider
{
    /// <summary>Delays execution for the specified duration.</summary>
    /// <param name="delay">The amount of time to wait.</param>
    /// <param name="ct">Cancellation token that cancels the delay.</param>
    /// <returns>A <see cref="ValueTask"/> that completes after the delay.</returns>
    ValueTask Delay(TimeSpan delay, CancellationToken ct);
}
