// <copyright file="TestInfrastructure.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO.Pipelines;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Credentials.Tests;

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

/// <summary>
/// A programmable <see cref="IProcessSpawner"/> whose behaviour is driven by a
/// <see cref="GcmScript"/>: each spawn returns a <see cref="ScriptedProcessHandle"/>
/// that reads the GCM verb from args, consumes stdin, and produces scripted stdout/exit-code.
/// </summary>
public sealed class GcmScriptSpawner : IProcessSpawner
{
    public GcmScript Script { get; } = new();

    public List<ProcessSpec> SpawnedSpecs { get; } = new();

    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.SpawnedSpecs.Add(spec);
        var verb = spec.Arguments.Length > 0 ? spec.Arguments[0] : "?";
        var handle = new ScriptedProcessHandle(verb, this.Script);
        return ValueTask.FromResult<IProcessHandle>(handle);
    }
}

public sealed class GcmScript
{
    // Response keyed by verb.
    public string GetStdout { get; set; } = "protocol=https\nhost=github.com\nusername=alice\npassword=super-sekret-42\n";

    public int GetExitCode { get; set; }

    public int StoreExitCode { get; set; }

    public int EraseExitCode { get; set; }

    public bool SimulateTimeout { get; set; }

    public TimeSpan? DelayBeforeExit { get; set; }
}

public sealed class ScriptedProcessHandle : IProcessHandle
{
    private readonly string verb;
    private readonly GcmScript script;
    private readonly Pipe stdoutPipe = new();
    private readonly Pipe stderrPipe = new();
    private readonly Pipe stdinPipe = new();
    private readonly TaskCompletionSource<int> exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposed;
    private bool writerDone;
    private readonly object writerLock = new();

    public ScriptedProcessHandle(string verb, GcmScript script)
    {
        this.verb = verb;
        this.script = script;
        ProcessId = System.Random.Shared.Next(1000, 9999);

        // Start the stdin-consumer / stdout-producer loop eagerly so that a reader of
        // StandardOut doesn't deadlock waiting for WaitForExitAsync to kick it off.
        _ = Task.Run(this.RunAsync);
    }

    public int ProcessId { get; }

    public PipeReader StandardOut => this.stdoutPipe.Reader;

    public PipeReader StandardError => this.stderrPipe.Reader;

    public PipeWriter StandardIn => this.stdinPipe.Writer;

    public string StdinBuffer { get; private set; } = string.Empty;

    private async Task RunAsync()
    {
        try
        {
            var sb = new System.Text.StringBuilder();
            while (true)
            {
                var rr = await this.stdinPipe.Reader.ReadAsync(CancellationToken.None).ConfigureAwait(false);
                foreach (var m in rr.Buffer)
                {
                    sb.Append(System.Text.Encoding.UTF8.GetString(m.Span));
                }

                this.stdinPipe.Reader.AdvanceTo(rr.Buffer.End);
                if (rr.IsCompleted) { break; }
            }

            this.StdinBuffer = sb.ToString();

            if (this.verb == "get" && !string.IsNullOrEmpty(this.script.GetStdout) && this.script.GetExitCode == 0)
            {
                await this.stdoutPipe.Writer.WriteAsync(System.Text.Encoding.UTF8.GetBytes(this.script.GetStdout), CancellationToken.None).ConfigureAwait(false);
            }

            this.CompleteWriters();

            if (this.script.SimulateTimeout)
            {
                // Never exit — let the caller's timeout cancel.
                await Task.Delay(Timeout.Infinite, CancellationToken.None).ConfigureAwait(false);
                return;
            }

            if (this.script.DelayBeforeExit is { } d)
            {
                await Task.Delay(d, CancellationToken.None).ConfigureAwait(false);
            }

            var code = this.verb switch
            {
                "get" => this.script.GetExitCode,
                "store" => this.script.StoreExitCode,
                "erase" => this.script.EraseExitCode,
                _ => 0,
            };
            _ = this.exit.TrySetResult(code);
        }
        catch (Exception ex)
        {
            _ = this.exit.TrySetException(ex);
            try { this.CompleteWriters(); } catch { }
        }
    }

    public Task<int> WaitForExitAsync(CancellationToken ct)
    {
        return ct.CanBeCanceled ? this.exit.Task.WaitAsync(ct) : this.exit.Task;
    }

    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
    {
        _ = this.exit.TrySetResult(-1);
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0) { return ValueTask.CompletedTask; }
        this.CompleteWriters();
        _ = this.exit.TrySetResult(-1);
        return ValueTask.CompletedTask;
    }

    private void CompleteWriters()
    {
        lock (this.writerLock)
        {
            if (this.writerDone) { return; }
            this.writerDone = true;
            try { this.stdoutPipe.Writer.Complete(); } catch { }
            try { this.stderrPipe.Writer.Complete(); } catch { }
        }
    }
}

public static class TestPrincipals
{
    public static AuthContext Alice() => new()
    {
        PrincipalId = "alice",
        DisplayName = "Alice",
        Scopes = ImmutableArray.Create("git.pull"),
        IssuedAtUtc = DateTimeOffset.UtcNow,
    };
}
