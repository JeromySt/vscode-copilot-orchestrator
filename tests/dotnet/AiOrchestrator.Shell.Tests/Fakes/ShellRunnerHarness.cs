// <copyright file="ShellRunnerHarness.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Shell.Tests.Fakes;

/// <summary>Convenience harness composing the fake collaborators used by every contract test.</summary>
internal sealed class ShellRunnerHarness
{
    public ShellRunnerHarness(AbsolutePath? tempDir = null)
    {
        this.TempDir = tempDir ?? new AbsolutePath(System.IO.Path.GetTempPath());
        this.Spawner = new FakeProcessSpawner();
        this.FileSystem = new FakeFileSystem();
        this.Clock = new FakeClock();
        this.Bus = new RecordingEventBus();
        this.Options = Microsoft.Extensions.Options.Options.Create(new ShellOptions { TempDir = this.TempDir });
        this.Runner = new ShellRunner(
            this.Spawner,
            this.FileSystem,
            this.Clock,
            this.Bus,
            new TestOptionsMonitor<ShellOptions>(this.Options.Value),
            NullLogger<ShellRunner>.Instance);
    }

    public AbsolutePath TempDir { get; }

    public FakeProcessSpawner Spawner { get; }

    public FakeFileSystem FileSystem { get; }

    public FakeClock Clock { get; }

    public RecordingEventBus Bus { get; }

    public IOptions<ShellOptions> Options { get; }

    public ShellRunner Runner { get; }

    public static RunContext SampleCtx() => new()
    {
        JobId = JobId.New(),
        RunId = RunId.New(),
        Principal = new AuthContext
        {
            PrincipalId = "user_123",
            DisplayName = "Test User",
            Scopes = ImmutableArray<string>.Empty,
        },
    };

    public ShellSpec MakeSpec(
        ShellKind kind = ShellKind.Pwsh,
        string script = "Write-Host hi",
        AbsolutePath? wd = null,
        TimeSpan? timeout = null,
        bool capture = true)
    {
        var workDir = wd ?? new AbsolutePath(System.IO.Path.GetTempPath());
        _ = this.FileSystem.ExistingPaths.Add(workDir.Value);
        return new ShellSpec
        {
            Shell = kind,
            Script = script,
            WorkingDirectory = workDir,
            Env = ImmutableDictionary<string, string>.Empty,
            Timeout = timeout,
            CaptureStdoutToLineView = capture,
        };
    }
}

internal sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
{
    public TestOptionsMonitor(T value) => this.CurrentValue = value;

    public T CurrentValue { get; }

    public T Get(string? name) => this.CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}
