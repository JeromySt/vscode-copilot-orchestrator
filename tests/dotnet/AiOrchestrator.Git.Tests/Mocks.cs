// <copyright file="Mocks.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

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
    public ValueTask<Credential> GetAsync(string url, AuthContext principal, CancellationToken ct)
        => ValueTask.FromResult(new Credential { Username = "x-token", Secret = "secret-pw-12345" });

    public ValueTask InvalidateAsync(string url, CancellationToken ct) => ValueTask.CompletedTask;
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
