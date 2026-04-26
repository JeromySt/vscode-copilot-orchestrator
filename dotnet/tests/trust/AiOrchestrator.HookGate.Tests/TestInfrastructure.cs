// <copyright file="TestInfrastructure.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.HookGate.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

/// <summary>Static IOptionsMonitor for tests — provides a fixed value without change notifications.</summary>
/// <typeparam name="T">Options type.</typeparam>
public sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    private readonly T value;

    public StaticOptionsMonitor(T value) => this.value = value;

    public T CurrentValue => this.value;

    public T Get(string? name) => this.value;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

/// <summary>Captures every <see cref="AuditRecord"/> appended for later inspection.</summary>
public sealed class InMemoryAuditLog : IAuditLog
{
    public List<AuditRecord> Records { get; } = new();

    public ValueTask AppendAsync(AuditRecord record, CancellationToken ct)
    {
        lock (this.Records)
        {
            this.Records.Add(record);
        }

        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<AuditRecord> ReadAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        List<AuditRecord> snap;
        lock (this.Records)
        {
            snap = new List<AuditRecord>(this.Records);
        }

        foreach (var r in snap)
        {
            yield return r;
        }

        await Task.CompletedTask;
    }

    public ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct) =>
        ValueTask.FromResult(new ChainVerification { Ok = true });
}

/// <summary>In-memory IEventBus that records all published events by type.</summary>
public sealed class InMemoryEventBus : IEventBus
{
    public List<object> Published { get; } = new();

    public ValueTask PublishAsync<TEvent>(TEvent @event, CancellationToken ct)
        where TEvent : notnull
    {
        lock (this.Published)
        {
            this.Published.Add(@event);
        }

        return ValueTask.CompletedTask;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull
        => new NullSub();

    private sealed class NullSub : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

/// <summary>Collects <see cref="HookGateNonceImmutabilityUnsupported"/> events for assertions.</summary>
public sealed class InMemoryImmutabilitySink : IImmutabilityEventSink
{
    public List<HookGateNonceImmutabilityUnsupported> Events { get; } = new();

    public ValueTask PublishAsync(HookGateNonceImmutabilityUnsupported evt, CancellationToken ct)
    {
        lock (this.Events)
        {
            this.Events.Add(evt);
        }

        return ValueTask.CompletedTask;
    }
}

/// <summary>A minimal <see cref="IProcessSpawner"/> that never actually runs anything — any call fails with exit -1.</summary>
public sealed class NullProcessSpawner : IProcessSpawner
{
    public List<ProcessSpec> SpawnedSpecs { get; } = new();

    public int ExitCodeForNextSpawn { get; set; } = -1;

    public string StdoutForNextSpawn { get; set; } = string.Empty;

    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        this.SpawnedSpecs.Add(spec);
        return ValueTask.FromResult<IProcessHandle>(new FakeProcessHandle(this.ExitCodeForNextSpawn, this.StdoutForNextSpawn));
    }
}

internal sealed class FakeProcessHandle : IProcessHandle
{
    private readonly int exit;
    private readonly System.IO.Pipelines.Pipe stdoutPipe = new();
    private readonly System.IO.Pipelines.Pipe stderrPipe = new();
    private readonly System.IO.Pipelines.Pipe stdinPipe = new();
    private int disposed;

    public FakeProcessHandle(int exit, string stdout)
    {
        this.exit = exit;
        _ = Task.Run(async () =>
        {
            if (!string.IsNullOrEmpty(stdout))
            {
                await this.stdoutPipe.Writer.WriteAsync(System.Text.Encoding.UTF8.GetBytes(stdout)).ConfigureAwait(false);
            }

            await this.stdoutPipe.Writer.CompleteAsync().ConfigureAwait(false);
            await this.stderrPipe.Writer.CompleteAsync().ConfigureAwait(false);
        });
    }

    public int ProcessId => 0;

    public System.IO.Pipelines.PipeReader StandardOut => this.stdoutPipe.Reader;

    public System.IO.Pipelines.PipeReader StandardError => this.stderrPipe.Reader;

    public System.IO.Pipelines.PipeWriter StandardIn => this.stdinPipe.Writer;

    public Task<int> WaitForExitAsync(CancellationToken ct) => Task.FromResult(this.exit);

    public ValueTask<AiOrchestrator.Abstractions.Process.ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<AiOrchestrator.Abstractions.Process.ProcessTreeNode?>(null);

    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0) { return ValueTask.CompletedTask; }
        try { this.stdoutPipe.Writer.Complete(); } catch { }
        try { this.stderrPipe.Writer.Complete(); } catch { }
        try { this.stdinPipe.Writer.Complete(); } catch { }
        return ValueTask.CompletedTask;
    }
}

public static class TestPrincipals
{
    public static AuthContext Alice() => new()
    {
        PrincipalId = "alice",
        DisplayName = "Alice",
        Scopes = ImmutableArray.Create("hook.run"),
        IssuedAtUtc = DateTimeOffset.UtcNow,
    };
}
