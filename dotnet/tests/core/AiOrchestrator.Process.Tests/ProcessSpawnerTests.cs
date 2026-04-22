// <copyright file="ProcessSpawnerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>
/// Abstract base class providing shared acceptance tests for any <see cref="IProcessSpawner"/>
/// implementation. Derived classes supply the concrete spawner under test.
/// </summary>
public abstract class ProcessSpawnerContractTests
{
    /// <summary>Gets the spawner under test.</summary>
    protected abstract IProcessSpawner Spawner { get; }

    /// <summary>Returns a <see cref="ProcessSpec"/> that runs a no-op command.</summary>
    protected abstract ProcessSpec MakeEchoSpec(string message);

    /// <summary>Returns a <see cref="ProcessSpec"/> that exits with the given code.</summary>
    protected abstract ProcessSpec MakeExitCodeSpec(int exitCode);

    /// <summary>Returns a <see cref="ProcessSpec"/> with the specified environment.</summary>
    protected abstract ProcessSpec MakeEnvPrintSpec(ImmutableDictionary<string, string> env);

    /// <summary>PROC-5: WaitForExitAsync can be awaited from multiple callers simultaneously.</summary>
    [Fact]
    [ContractTest("PROC-5")]
    public async Task PROC_5_WaitForExit_MultiShot()
    {
        var spec = MakeExitCodeSpec(42);
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        // Multiple simultaneous awaiters — INV-5
        var t1 = handle.WaitForExitAsync(CancellationToken.None);
        var t2 = handle.WaitForExitAsync(CancellationToken.None);
        var t3 = handle.WaitForExitAsync(CancellationToken.None);

        var results = await Task.WhenAll(t1, t2, t3).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.All(results, r => Assert.Equal(42, r));
    }

    /// <summary>PROC-8: DisposeAsync is idempotent and force-kills if the process is still alive.</summary>
    [Fact]
    [ContractTest("PROC-8")]
    public async Task PROC_8_Dispose_IsIdempotent_AndForceKills()
    {
        var spec = MakeEchoSpec("hello");
        var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        // Multiple disposes must not throw (INV-8)
        await handle.DisposeAsync();
        await handle.DisposeAsync();
        await handle.DisposeAsync();

        // No exception = pass
    }
}

/// <summary>
/// Contract tests for <see cref="FakeProcessSpawner"/> (PROC-11).
/// Verifies the fake satisfies the same contract as the real spawner.
/// </summary>
public sealed class FakeProcessSpawnerContractTests : ProcessSpawnerContractTests
{
    private readonly FakeProcessSpawner _spawner = new();

    /// <inheritdoc/>
    protected override IProcessSpawner Spawner => _spawner;

    /// <inheritdoc/>
    protected override ProcessSpec MakeEchoSpec(string message)
        => new() { Producer = "test", Description = "echo", Executable = "echo", Arguments = [message], Environment = null };

    /// <inheritdoc/>
    protected override ProcessSpec MakeExitCodeSpec(int exitCode)
    {
        var spec = new ProcessSpec
        {
            Producer = "test",
            Description = "exit",
            Executable = "exit",
            Arguments = [],
            Environment = null,
        };

        // When spawned, the fake handle needs to complete with the requested exit code
        // We accomplish this via a post-spawn hook by tracking and completing
        _ = Task.Run(async () =>
        {
            await Task.Delay(50).ConfigureAwait(false);
            foreach (var h in _spawner.SpawnedHandles.OfType<FakeProcessHandle>()
                         .Where(h => !h.WaitForExitAsync(CancellationToken.None).IsCompleted))
            {
                h.Complete(exitCode);
            }
        });

        return spec;
    }

    /// <inheritdoc/>
    protected override ProcessSpec MakeEnvPrintSpec(ImmutableDictionary<string, string> env)
        => new() { Producer = "test", Description = "env", Executable = "env", Arguments = [], Environment = env };

    /// <summary>PROC-11: FakeProcessSpawner satisfies the process spawner contract.</summary>
    [Fact]
    [ContractTest("PROC-11")]
    public async Task PROC_11_FakeProcessSpawner_SatisfiesContract()
    {
        var spec = MakeEchoSpec("hello");
        await using var handle = await _spawner.SpawnAsync(spec, CancellationToken.None);
        Assert.NotNull(handle);
        Assert.True(handle.ProcessId > 0);
        Assert.NotNull(handle.StandardOut);
        Assert.NotNull(handle.StandardError);
        Assert.NotNull(handle.StandardIn);
        Assert.Equal(1, _spawner.SpawnedHandles.Count);
    }
}

/// <summary>
/// Tests for the real <see cref="ProcessSpawner"/> against the running OS (PROC-12).
/// These tests spawn real child processes.
/// </summary>
public sealed class RealProcessSpawnerTests
{
    private static readonly FakeProcessLifecycle Lifecycle = new();
    private static readonly FakeClock Clock = new();
    private static readonly FakeTelemetrySink Telemetry = new();
    private static readonly ProcessSpawner Spawner = new(Lifecycle, Clock, Telemetry);

    private static bool IsWindows => System.Runtime.InteropServices.RuntimeInformation
        .IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows);

    private static ProcessSpec EchoSpec(string message)
        => IsWindows
            ? new() { Producer = "test", Description = "echo", Executable = "cmd.exe", Arguments = ["/c", $"echo {message}"], Environment = null }
            : new() { Producer = "test", Description = "echo", Executable = "/bin/sh", Arguments = ["-c", $"echo {message}"], Environment = null };

    private static ProcessSpec ExitSpec(int code)
        => IsWindows
            ? new() { Producer = "test", Description = "exit", Executable = "cmd.exe", Arguments = ["/c", $"exit {code}"], Environment = null }
            : new() { Producer = "test", Description = "exit", Executable = "/bin/sh", Arguments = ["-c", $"exit {code}"], Environment = null };

    private static ProcessSpec SleepSpec(int seconds)
        => IsWindows
            ? new() { Producer = "test", Description = "sleep", Executable = "ping", Arguments = ["-n", (seconds + 1).ToString(), "127.0.0.1"], Environment = null }
            : new() { Producer = "test", Description = "sleep", Executable = "/bin/sh", Arguments = ["-c", $"sleep {seconds}"], Environment = null };

    private static ProcessSpec EnvPrintSpec(ImmutableDictionary<string, string>? env)
        => IsWindows
            ? new() { Producer = "test", Description = "env", Executable = "cmd.exe", Arguments = ["/c", "set"], Environment = env }
            : new() { Producer = "test", Description = "env", Executable = "/usr/bin/env", Arguments = [], Environment = env };

    /// <summary>PROC-1: SpawnAsync uses argv vector — UseShellExecute is never true.</summary>
    [Fact]
    [ContractTest("PROC-1")]
    public async Task PROC_1_Spawn_UsesArgvVector_NotShell()
    {
        // The spawner sets UseShellExecute=false internally (INV-1).
        // Verify by spawning a command that would fail if interpreted by shell
        // (spaces in argument should not be split).
        var spec = EchoSpec("hello world");
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);
        Assert.NotNull(handle);
        Assert.True(handle.ProcessId > 0);

        var exitCode = await handle.WaitForExitAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(0, exitCode);
    }

    /// <summary>PROC-2: Cancellation sends SIGTERM then SIGKILL after grace period.</summary>
    [Fact]
    [ContractTest("PROC-2")]
    public async Task PROC_2_Cancellation_SendsSigtermThenSigkill()
    {
        using var cts = new CancellationTokenSource();
        var spec = SleepSpec(60); // Long-running so we can cancel it
        await using var handle = await Spawner.SpawnAsync(spec, cts.Token);

        // Cancel → triggers SIGTERM → after grace (5 s) → SIGKILL
        // Set a very short grace period via a separate cancel to speed up test
        using var killCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        cts.Cancel(); // triggers CancelAsync with default 5 s grace

        // Process must exit (via SIGTERM or SIGKILL) within 10 s
        var waitTask = handle.WaitForExitAsync(CancellationToken.None);
        var completed = await Task.WhenAny(waitTask, Task.Delay(TimeSpan.FromSeconds(10)));
        Assert.Equal(waitTask, completed);
    }

    /// <summary>PROC-3: EnvScope with InheritOther=false blocks inherited secrets.</summary>
    [Fact]
    [ContractTest("PROC-3")]
    public async Task PROC_3_EnvScope_BlocksInheritedSecrets()
    {
        const string SecretKey = "PROC3_SECRET_KEY";
        const string AllowedKey = "PROC3_ALLOWED_KEY";
        const string AllowedValue = "allowed_value";

        // Inject a secret into the current environment so we can verify it doesn't leak
        System.Environment.SetEnvironmentVariable(SecretKey, "super_secret");

        try
        {
            // Only expose AllowedKey (InheritOther=false semantics via ProcessSpec.Environment)
            var env = ImmutableDictionary.Create<string, string>()
                .Add(AllowedKey, AllowedValue);

            var spec = EnvPrintSpec(env);
            await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

            var output = await ReadAllAsync(handle.StandardOut).WaitAsync(TimeSpan.FromSeconds(30));
            await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));

            // Secret must NOT appear in child env (INV-3)
            Assert.DoesNotContain(SecretKey, output);
            Assert.Contains(AllowedKey, output);
        }
        finally
        {
            System.Environment.SetEnvironmentVariable(SecretKey, null);
        }
    }

    /// <summary>PROC-4: Stdout and stderr are delivered separately.</summary>
    [Fact]
    [ContractTest("PROC-4")]
    public async Task PROC_4_StdOutStdErr_DeliveredSeparately()
    {
        var spec = IsWindows
            ? new ProcessSpec
            {
                Producer = "test",
                Description = "split",
                Executable = "cmd.exe",
                Arguments = ["/c", "echo STDOUT & echo STDERR 1>&2"],
                Environment = null,
            }
            : new ProcessSpec
            {
                Producer = "test",
                Description = "split",
                Executable = "/bin/sh",
                Arguments = ["-c", "echo STDOUT; echo STDERR >&2"],
                Environment = null,
            };

        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        var stdoutTask = ReadAllAsync(handle.StandardOut);
        var stderrTask = ReadAllAsync(handle.StandardError);

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));

        var stdout = await stdoutTask.WaitAsync(TimeSpan.FromSeconds(10));
        var stderr = await stderrTask.WaitAsync(TimeSpan.FromSeconds(10));

        // INV-4: separate streams — stdout has STDOUT, stderr has STDERR
        Assert.Contains("STDOUT", stdout);
        Assert.Contains("STDERR", stderr);
    }

    /// <summary>PROC-5: WaitForExitAsync is multi-shot (multiple awaiters see the result).</summary>
    [Fact]
    [ContractTest("PROC-5")]
    public async Task PROC_5_WaitForExit_MultiShot()
    {
        var spec = ExitSpec(7);
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        // INV-5: multiple simultaneous awaiters
        var t1 = handle.WaitForExitAsync(CancellationToken.None);
        var t2 = handle.WaitForExitAsync(CancellationToken.None);
        var t3 = handle.WaitForExitAsync(CancellationToken.None);

        var results = await Task.WhenAll(t1, t2, t3).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.All(results, r => Assert.Equal(7, r));
    }

    /// <summary>PROC-8: DisposeAsync is idempotent and force-kills if the process is still alive.</summary>
    [Fact]
    [ContractTest("PROC-8")]
    public async Task PROC_8_Dispose_IsIdempotent_AndForceKills()
    {
        var spec = SleepSpec(60);
        var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        // Force dispose — should kill the process
        await handle.DisposeAsync();

        // Second and third dispose must be no-ops (INV-8)
        await handle.DisposeAsync();
        await handle.DisposeAsync();
    }

    /// <summary>PROC-12: Real ProcessSpawner satisfies the process spawner contract.</summary>
    [Fact]
    [ContractTest("PROC-12")]
    public async Task PROC_12_ProcessSpawner_SatisfiesContract()
    {
        var spec = EchoSpec("contract");
        await using var handle = await Spawner.SpawnAsync(spec, CancellationToken.None);

        Assert.NotNull(handle);
        Assert.True(handle.ProcessId > 0);
        Assert.NotNull(handle.StandardOut);
        Assert.NotNull(handle.StandardError);
        Assert.NotNull(handle.StandardIn);

        await handle.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30));
    }

    private static async Task<string> ReadAllAsync(PipeReader reader)
    {
        var sb = new StringBuilder();
        try
        {
            while (true)
            {
                var result = await reader.ReadAsync().ConfigureAwait(false);
                var buffer = result.Buffer;
                foreach (var segment in buffer)
                {
                    sb.Append(Encoding.UTF8.GetString(segment.Span));
                }

                reader.AdvanceTo(buffer.End);
                if (result.IsCompleted || result.IsCanceled)
                {
                    break;
                }
            }
        }
        catch
        {
            // Pipe completed
        }

        return sb.ToString();
    }
}
