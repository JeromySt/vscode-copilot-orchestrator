// <copyright file="IClock.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Time;

/// <summary>
/// Provides access to the current time and a monotonic millisecond counter,
/// allowing code to be tested without depending on wall-clock time.
/// </summary>
public interface IClock
{
    /// <summary>Gets the current UTC time.</summary>
    DateTimeOffset UtcNow { get; }

    /// <summary>Gets a monotonically increasing counter in milliseconds, suitable for measuring elapsed time.</summary>
    long MonotonicMilliseconds { get; }
}
