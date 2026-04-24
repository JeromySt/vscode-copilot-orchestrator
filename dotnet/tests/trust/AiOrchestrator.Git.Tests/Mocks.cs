// <copyright file="Mocks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SysProcess = System.Diagnostics.Process;

namespace AiOrchestrator.Git.Tests;

internal static class Mocks
{
    public static AuthContext TestPrincipal { get; } = new()
    {
        PrincipalId = "tester@example.com",
        DisplayName = "tester",
        Scopes = ImmutableArray<string>.Empty,
    };

    public static IOptionsMonitor<GitOptions> Opts(GitOptions? value = null)
        => new TestOpts(value ?? new GitOptions());

    public static NullLogger<GitOperations> NullLog { get; } = NullLogger<GitOperations>.Instance;

    private sealed class TestOpts(GitOptions value) : IOptionsMonitor<GitOptions>
    {
        public GitOptions CurrentValue => value;

        public GitOptions Get(string? name) => value;

        public IDisposable? OnChange(Action<GitOptions, string?> listener) => null;
    }
}

internal sealed class StubCredentialBroker : ICredentialBroker
{
    public ValueTask<Credential> GetAsync(Uri repoUrl, AuthContext principal, CancellationToken ct)
        => ValueTask.FromResult(new Credential
        {
            Username = "x-token",
            Password = new ProtectedString("secret-pw-12345"),
            RetrievedAt = DateTimeOffset.UtcNow,
            SourceProtocol = "https",
        });

    public ValueTask StoreAsync(Uri repoUrl, Credential credential, AuthContext principal, CancellationToken ct)
        => ValueTask.CompletedTask;

    public ValueTask EraseAsync(Uri repoUrl, AuthContext principal, CancellationToken ct)
        => ValueTask.CompletedTask;
}

internal sealed class StubProcessSpawner : IProcessSpawner
{
    public Func<ProcessSpec, IProcessHandle> Factory { get; set; } = _ => throw new InvalidOperationException("no factory");

    public List<ProcessSpec> Calls { get; } = new();

    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        this.Calls.Add(spec);
        return ValueTask.FromResult(this.Factory(spec));
    }
}

internal sealed class FakeProcessHandle : IProcessHandle
{
    private readonly Pipe outPipe = new();
    private readonly Pipe errPipe = new();
    private readonly Pipe inPipe = new();

    public FakeProcessHandle(int exitCode = 0, string stdout = "", string stderr = "")
    {
        this.ExitCodeValue = exitCode;
        this.StdoutText = stdout;
        this.StderrText = stderr;
    }

    public int ProcessId => 12345;

    public int ExitCodeValue { get; }

    public string StdoutText { get; }

    public string StderrText { get; }

    public PipeReader StandardOut => this.outPipe.Reader;

    public PipeReader StandardError => this.errPipe.Reader;

    public PipeWriter StandardIn => this.inPipe.Writer;

    public async Task<int> WaitForExitAsync(CancellationToken ct)
    {
        var stdoutBytes = System.Text.Encoding.UTF8.GetBytes(this.StdoutText);
        await this.outPipe.Writer.WriteAsync(stdoutBytes, ct).ConfigureAwait(false);
        await this.outPipe.Writer.CompleteAsync().ConfigureAwait(false);

        var stderrBytes = System.Text.Encoding.UTF8.GetBytes(this.StderrText);
        await this.errPipe.Writer.WriteAsync(stderrBytes, ct).ConfigureAwait(false);
        await this.errPipe.Writer.CompleteAsync().ConfigureAwait(false);

        return this.ExitCodeValue;
    }

    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct) => ValueTask.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>
/// Minimal <see cref="IProcessSpawner"/> that actually starts real processes.
/// Used in integration tests that run real git commands.
/// Test projects are exempt from OE0005/OE0012 analyzers.
/// </summary>
internal sealed class RealProcessSpawner : IProcessSpawner
{
    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(spec.Executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var arg in spec.Arguments)
        {
            psi.ArgumentList.Add(arg);
        }

        if (spec.Environment is not null)
        {
            foreach (var kvp in spec.Environment)
            {
                psi.Environment[kvp.Key] = kvp.Value;
            }
        }

        var process = SysProcess.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {spec.Executable}");

        return ValueTask.FromResult<IProcessHandle>(new RealProcessHandle(process));
    }
}

/// <summary>
/// Wraps a real <see cref="SysProcess"/> behind the <see cref="IProcessHandle"/> interface.
/// </summary>
internal sealed class RealProcessHandle : IProcessHandle
{
    private readonly SysProcess process;
    private readonly Pipe outPipe = new();
    private readonly Pipe errPipe = new();
    private readonly Pipe inPipe = new();
    private readonly Task outPump;
    private readonly Task errPump;

    public RealProcessHandle(SysProcess process)
    {
        this.process = process;
        this.outPump = PumpAsync(process.StandardOutput.BaseStream, this.outPipe.Writer);
        this.errPump = PumpAsync(process.StandardError.BaseStream, this.errPipe.Writer);
    }

    public int ProcessId => this.process.Id;

    public PipeReader StandardOut => this.outPipe.Reader;

    public PipeReader StandardError => this.errPipe.Reader;

    public PipeWriter StandardIn => this.inPipe.Writer;

    public async Task<int> WaitForExitAsync(CancellationToken ct)
    {
        await this.process.WaitForExitAsync(ct).ConfigureAwait(false);
        await Task.WhenAll(this.outPump, this.errPump).ConfigureAwait(false);
        return this.process.ExitCode;
    }

    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
    {
        try
        {
            this.process.Kill();
        }
        catch (InvalidOperationException)
        {
            // Already exited
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        this.process.Dispose();
        return ValueTask.CompletedTask;
    }

    private static async Task PumpAsync(Stream source, PipeWriter writer)
    {
        try
        {
            var buffer = new byte[4096];
            int bytesRead;
            while ((bytesRead = await source.ReadAsync(buffer).ConfigureAwait(false)) > 0)
            {
                await writer.WriteAsync(buffer.AsMemory(0, bytesRead)).ConfigureAwait(false);
            }
        }
        finally
        {
            await writer.CompleteAsync().ConfigureAwait(false);
        }
    }
}
