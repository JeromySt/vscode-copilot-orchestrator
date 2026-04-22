// <copyright file="ClockTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Composition;
using AiOrchestrator.TestKit.Time;
using AiOrchestrator.Time;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AiOrchestrator.Time.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "CLOCK-1").</param>
    public ContractTestAttribute(string id) => Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}

/// <summary>Acceptance tests for the Time layer (CLOCK-1 through CLOCK-5).</summary>
public sealed class ClockTests
{
    [Fact]
    [ContractTest("CLOCK-1")]
    public void CLOCK_1_UtcNow_ReturnsUtc()
    {
        var clock = new SystemClock();

        Assert.Equal(TimeSpan.Zero, clock.UtcNow.Offset);
    }

    [Fact]
    [ContractTest("CLOCK-2")]
    public void CLOCK_2_Monotonic_NeverGoesBackward_Under1MIterations()
    {
        var clock = new SystemClock();
        var last = clock.MonotonicMilliseconds;

        for (var i = 0; i < 1_000_000; i++)
        {
            var current = clock.MonotonicMilliseconds;
            Assert.True(current >= last,
                $"monotonic clock went backward at iteration {i}: {last} → {current}");
            last = current;
        }
    }

    [Fact]
    [ContractTest("CLOCK-3")]
    public void CLOCK_3_MonotonicGuard_DetectsRegression_Throws()
    {
        var inner = new InMemoryClock(DateTimeOffset.UtcNow, monotonicMs: 1000);
        var telemetry = new RecordingTelemetrySink();
        var guard = new MonotonicGuard(inner, telemetry);

        // First read establishes the baseline at 1000 ms
        Assert.Equal(1000, guard.MonotonicMilliseconds);

        // Regress the inner clock below the baseline
        inner.SetMonotonicMs(500);

        // Guard must throw and record telemetry
        var ex = Assert.Throws<MonotonicRegressionException>(() => guard.MonotonicMilliseconds);

        Assert.Equal(1000, ex.Previous);
        Assert.Equal(500, ex.Current);

        Assert.True(telemetry.Counters.ContainsKey("MonotonicClockRegression"));
        Assert.Equal(1, telemetry.Counters["MonotonicClockRegression"]);
    }

    [Fact]
    [ContractTest("CLOCK-4")]
    public async Task CLOCK_4_DelayProvider_HonorsCancellationWithin50ms()
    {
        var provider = new SystemDelayProvider();
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // Pre-cancel so the delay fails immediately

        var sw = Stopwatch.StartNew();
        var threw = false;
        try
        {
            await provider.Delay(TimeSpan.FromSeconds(60), cts.Token);
        }
        catch (OperationCanceledException)
        {
            threw = true;
        }
        finally
        {
            sw.Stop();
        }

        Assert.True(threw, "cancellation must propagate as OperationCanceledException");
        Assert.True(sw.ElapsedMilliseconds < 50, "cancellation must be honored within 50 ms");
    }

    [Fact]
    [ContractTest("CLOCK-5")]
    public void CLOCK_5_DefaultRegistration_IsMonotonicGuardWrappingSystemClock()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ITelemetrySink>(new NullTelemetrySink());
        services.AddTime();

        using var sp = services.BuildServiceProvider();

        var clock = sp.GetRequiredService<IClock>();
        Assert.IsType<MonotonicGuard>(clock);

        var delay = sp.GetRequiredService<IDelayProvider>();
        Assert.IsType<SystemDelayProvider>(delay);
    }

    private sealed class RecordingTelemetrySink : ITelemetrySink
    {
        public Dictionary<string, long> Counters { get; } = new(StringComparer.Ordinal);

        public void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null)
        {
            Counters.TryGetValue(name, out var existing);
            Counters[name] = existing + delta;
        }

        public void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null)
        {
        }

        public IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null)
            => NullScope.Instance;
    }

    private sealed class NullTelemetrySink : ITelemetrySink
    {
        public void RecordCounter(string name, long delta, IReadOnlyDictionary<string, object>? tags = null)
        {
        }

        public void RecordHistogram(string name, double value, IReadOnlyDictionary<string, object>? tags = null)
        {
        }

        public IDisposable StartActivity(string name, IReadOnlyDictionary<string, object>? tags = null)
            => NullScope.Instance;
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}

/// <summary>
/// CLOCK-6: Verifies that <see cref="InMemoryClock"/> from the TestKit satisfies the <see cref="ClockContractTests"/> contract.
/// </summary>
public sealed class CLOCK_6_TestKitInMemoryClock_SatisfiesContract : ClockContractTests
{
    /// <inheritdoc />
    protected override IClock CreateClock() => new InMemoryClock();
}

/// <summary>
/// CLOCK-7: Verifies that <see cref="SystemClock"/> satisfies the <see cref="ClockContractTests"/> contract.
/// </summary>
public sealed class CLOCK_7_SystemClock_SatisfiesContract : ClockContractTests
{
    /// <inheritdoc />
    protected override IClock CreateClock() => new SystemClock();
}
