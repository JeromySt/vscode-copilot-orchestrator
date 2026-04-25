// <copyright file="HostConcurrencyBrokerClientTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Concurrency.Broker.Exceptions;
using AiOrchestrator.Concurrency.Broker.Fairness;
using AiOrchestrator.Concurrency.Broker.Rpc;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Concurrency.Broker.Tests;

/// <summary>Coverage tests for <see cref="HostConcurrencyBrokerClient"/>.</summary>
public sealed class HostConcurrencyBrokerClientTests
{
    private static AuthContext MakePrincipal(string id) => new()
    {
        PrincipalId = id,
        DisplayName = id,
        Scopes = ImmutableArray<string>.Empty,
    };

    /// <summary>When daemon is null, returns passthrough admission immediately.</summary>
    [Fact]
    public async Task NullDaemon_ReturnsPassthrough()
    {
        var logger = NullLogger<HostConcurrencyBrokerClient>.Instance;
        var client = new HostConcurrencyBrokerClient(null, logger);
        var principal = MakePrincipal("user1");
        var job = JobId.New();

        var admission = await client.AcquireAsync(principal, job, CancellationToken.None);

        Assert.Equal("user1", admission.Principal.PrincipalId);
        Assert.StartsWith("passthrough-", admission.BrokerLeaseId);
        await admission.DisposeAsync();
    }

    /// <summary>When daemon is null, second call does not duplicate the warning log.</summary>
    [Fact]
    public async Task NullDaemon_WarnsOnlyOnce()
    {
        var logger = new RecordingLogger<HostConcurrencyBrokerClient>();
        var client = new HostConcurrencyBrokerClient(null, logger);
        var principal = MakePrincipal("user1");

        var a1 = await client.AcquireAsync(principal, JobId.New(), CancellationToken.None);
        var a2 = await client.AcquireAsync(principal, JobId.New(), CancellationToken.None);

        Assert.Single(logger.Warnings);
        Assert.Contains("unavailable", logger.Warnings[0], StringComparison.OrdinalIgnoreCase);

        await a1.DisposeAsync();
        await a2.DisposeAsync();
    }

    /// <summary>When daemon throws BrokerUnavailableException, falls back to passthrough.</summary>
    [Fact]
    public async Task DaemonThrowsBrokerUnavailable_FallsBackToPassthrough()
    {
        var daemon = MakeThrowingDaemon();
        var logger = new RecordingLogger<HostConcurrencyBrokerClient>();
        var client = new HostConcurrencyBrokerClient(daemon, logger);
        var principal = MakePrincipal("user2");

        var admission = await client.AcquireAsync(principal, JobId.New(), CancellationToken.None);

        Assert.Equal("user2", admission.Principal.PrincipalId);
        Assert.StartsWith("passthrough-", admission.BrokerLeaseId);
        Assert.Single(logger.Warnings);
        await admission.DisposeAsync();
    }

    /// <summary>When daemon works, delegates directly without passthrough.</summary>
    [Fact]
    public async Task WorkingDaemon_DelegatesDirectly()
    {
        var daemon = MakeWorkingDaemon();
        var logger = NullLogger<HostConcurrencyBrokerClient>.Instance;
        var client = new HostConcurrencyBrokerClient(daemon, logger);
        var principal = MakePrincipal("user3");

        await daemon.StartAsync(CancellationToken.None);
        var admission = await client.AcquireAsync(principal, JobId.New(), CancellationToken.None);

        Assert.Equal("user3", admission.Principal.PrincipalId);
        Assert.DoesNotContain("passthrough", admission.BrokerLeaseId);
        await admission.DisposeAsync();

        await daemon.StopAsync(CancellationToken.None);
        await daemon.DisposeAsync();
    }

    /// <summary>Passthrough admission can be disposed multiple times without error (idempotent).</summary>
    [Fact]
    public async Task PassthroughAdmission_DisposeIsIdempotent()
    {
        var client = new HostConcurrencyBrokerClient(null, NullLogger<HostConcurrencyBrokerClient>.Instance);
        var admission = await client.AcquireAsync(MakePrincipal("u"), JobId.New(), CancellationToken.None);

        await admission.DisposeAsync();
        await admission.DisposeAsync(); // Must not throw
    }

    // ─────────────── helpers ───────────────

    private static HostConcurrencyBrokerDaemon MakeThrowingDaemon()
    {
        // A daemon that is "shutting down" — AcquireAsync will throw BrokerUnavailableException.
        var bus = new NullEventBus();
        var clock = new InMemoryClock();
        var opts = new FixedOptions<BrokerOptions>(new BrokerOptions());
        var scheduler = new FairnessScheduler(clock, opts, bus);
        var rpc = new NullRpcServer();

        var daemon = new HostConcurrencyBrokerDaemon(rpc, scheduler, clock, bus, opts, NullLogger<HostConcurrencyBrokerDaemon>.Instance);
        // Start then stop to put it in "shutting down" state
        daemon.StartAsync(CancellationToken.None).GetAwaiter().GetResult();
        daemon.StopAsync(CancellationToken.None).GetAwaiter().GetResult();
        return daemon;
    }

    private static HostConcurrencyBrokerDaemon MakeWorkingDaemon()
    {
        var bus = new NullEventBus();
        var clock = new InMemoryClock();
        var opts = new FixedOptions<BrokerOptions>(new BrokerOptions());
        var scheduler = new FairnessScheduler(clock, opts, bus);
        var rpc = new NullRpcServer();
        return new HostConcurrencyBrokerDaemon(rpc, scheduler, clock, bus, opts, NullLogger<HostConcurrencyBrokerDaemon>.Instance);
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel == LogLevel.Warning)
            {
                Warnings.Add(formatter(state, exception));
            }
        }
    }

    private sealed class FixedOptions<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue => value;
        public T Get(string? name) => value;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    private sealed class NullRpcServer : IRpcServer
    {
        public Task StartAsync(CancellationToken ct) => Task.CompletedTask;
        public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class NullEventBus : Abstractions.Eventing.IEventBus
    {
        public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
            where TEvent : notnull => ValueTask.CompletedTask;

        public IAsyncDisposable Subscribe<TEvent>(
            Abstractions.Eventing.EventFilter filter,
            Func<TEvent, CancellationToken, ValueTask> handler) where TEvent : notnull
            => NullDisposable.Instance;

        private sealed class NullDisposable : IAsyncDisposable
        {
            public static readonly NullDisposable Instance = new();
            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
