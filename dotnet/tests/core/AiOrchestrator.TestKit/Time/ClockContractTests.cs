// <copyright file="ClockContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Time;
using Xunit;

namespace AiOrchestrator.TestKit.Time;

/// <summary>
/// Abstract base class for xunit test suites that verify an <see cref="IClock"/> implementation
/// satisfies the basic contract: UTC offset, non-decreasing monotonic counter.
/// Inherit this class and override <see cref="CreateClock"/> to run the suite against any clock.
/// </summary>
public abstract class ClockContractTests
{
    /// <summary>Verifies that <see cref="IClock.UtcNow"/> always returns a UTC-offset value.</summary>
    [Fact]
    public void UtcNow_ReturnsUtcOffset()
    {
        var clock = this.CreateClock();
        Assert.Equal(TimeSpan.Zero, clock.UtcNow.Offset);
    }

    /// <summary>Verifies that successive reads of <see cref="IClock.MonotonicMilliseconds"/> never decrease.</summary>
    [Fact]
    public void MonotonicMilliseconds_IsNonDecreasing_OnSuccessiveReads()
    {
        var clock = this.CreateClock();
        var previous = clock.MonotonicMilliseconds;

        for (var i = 0; i < 100; i++)
        {
            var current = clock.MonotonicMilliseconds;
            Assert.True(current >= previous, $"monotonic counter must not decrease (iteration {i}): {current} < {previous}");
            previous = current;
        }
    }

    /// <summary>Creates a fresh instance of the <see cref="IClock"/> under test.</summary>
    /// <returns>A new clock instance.</returns>
    protected abstract IClock CreateClock();
}
