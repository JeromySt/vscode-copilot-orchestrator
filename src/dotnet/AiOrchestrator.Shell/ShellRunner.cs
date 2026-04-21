// <copyright file="ShellRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models;
using AiOrchestrator.Shell.Eventing;
using AiOrchestrator.Shell.Exceptions;
using AiOrchestrator.Shell.PowerShell;
using AiOrchestrator.Shell.Temp;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Shell;

/// <summary>
/// Default <see cref="IShellRunner"/> implementation. Spawns hardened shell processes
/// through <see cref="IProcessSpawner"/>, executing scripts written to per-run
/// <see cref="SecureTempScript"/> files. Enforces invariants INV-1..INV-10.
/// </summary>
public sealed class ShellRunner : IShellRunner
{
    private static readonly TimeSpan KillGracePeriod = TimeSpan.FromSeconds(10);

    private readonly IProcessSpawner spawner;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<ShellOptions> opts;
    private readonly ILogger<ShellRunner> logger;
    private readonly PowerShellCommandLineBuilder psBuilder = new();

    /// <summary>Initializes a new instance of the <see cref="ShellRunner"/> class.</summary>
    /// <param name="spawner">Process spawner abstraction (job 10).</param>
    /// <param name="fs">Filesystem abstraction (job 9).</param>
    /// <param name="clock">Clock for elapsed-time measurement (job 8).</param>
    /// <param name="bus">Event bus for line/stderr routing (job 12).</param>
    /// <param name="opts">Runtime-mutable shell options.</param>
    /// <param name="logger">Logger.</param>
    public ShellRunner(
        IProcessSpawner spawner,
        IFileSystem fs,
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<ShellOptions> opts,
        ILogger<ShellRunner> logger)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(fs);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);

        this.spawner = spawner;
        this.fs = fs;
        this.clock = clock;
        this.bus = bus;
        this.opts = opts;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public async ValueTask<ShellRunResult> RunAsync(ShellSpec spec, RunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(ctx);

        // INV-10: working directory must exist.
        if (!await this.fs.ExistsAsync(spec.WorkingDirectory, ct).ConfigureAwait(false))
        {
            throw new WorkingDirectoryNotFoundException(spec.WorkingDirectory);
        }

        var options = this.opts.CurrentValue;
        var timeout = spec.Timeout ?? options.DefaultTimeout;

        var bytes = Encoding.UTF8.GetBytes(spec.Script);
        var extension = ExtensionFor(spec.Shell);

        await using var temp = new SecureTempScript(options.TempDir);
        var scriptPath = await temp.CreateAsync(bytes, extension, ct).ConfigureAwait(false);

        var (executable, args) = this.BuildArgv(spec.Shell, scriptPath);

        // INV-4: defense-in-depth — re-validate that no forbidden PowerShell flag has snuck in.
        if (IsPowerShellKind(spec.Shell) && this.psBuilder.ContainsForbiddenFlags(args))
        {
            throw new InvalidOperationException(
                "PowerShell argv contains forbidden flag (-Command/-EncodedCommand). PS-ISO-1/PS-ISO-4 violation.");
        }

        var processSpec = new ProcessSpec
        {
            Producer = "shell-runner",
            Description = $"shell:{spec.Shell}",
            Executable = executable,
            Arguments = args,
            Environment = spec.Env, // INV-5: env flows through process env, never interpolated into the script.
        };

        var startMs = this.clock.MonotonicMilliseconds;
        await using var handle = await this.spawner.SpawnAsync(processSpec, ct).ConfigureAwait(false);

        var stdoutCounter = new ByteCountingPumpResult();
        var stderrCounter = new ByteCountingPumpResult();

        var stdoutTask = this.PumpStreamAsync(
            handle.StandardOut, stdoutCounter, spec, ctx, ShellStream.Stdout, ct);
        var stderrTask = this.PumpStreamAsync(
            handle.StandardError, stderrCounter, spec, ctx, ShellStream.Stderr, ct);

        var exitTask = handle.WaitForExitAsync(ct);
        var timeoutTask = Task.Delay(timeout, ct);

        var winner = await Task.WhenAny(exitTask, timeoutTask).ConfigureAwait(false);
        var timedOut = false;
        int exitCode;

        if (winner == timeoutTask && !exitTask.IsCompleted)
        {
            timedOut = true;
            this.logger.LogWarning(
                "Shell run timed out after {TimeoutMs}ms (job {JobId}, run {RunId})",
                timeout.TotalMilliseconds,
                ctx.JobId,
                ctx.RunId);

            // INV-9: SIGTERM, wait grace period, then SIGKILL.
            try
            {
                await handle.SignalAsync(ProcessSignal.Terminate, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException)
            {
                // process may already be gone
            }

            var graceFinished = await Task.WhenAny(exitTask, Task.Delay(KillGracePeriod, CancellationToken.None))
                .ConfigureAwait(false);

            if (graceFinished != exitTask)
            {
                try
                {
                    await handle.SignalAsync(ProcessSignal.Kill, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is InvalidOperationException or IOException)
                {
                    // best-effort
                }
            }

            exitCode = await exitTask.ConfigureAwait(false);
        }
        else
        {
            exitCode = await exitTask.ConfigureAwait(false);
        }

        // Wait for the pump tasks to drain.
        try
        {
            await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // expected when ct fires; counters still hold partial totals
        }

        var endMs = this.clock.MonotonicMilliseconds;
        var duration = TimeSpan.FromMilliseconds(Math.Max(0, endMs - startMs));

        return new ShellRunResult
        {
            ExitCode = exitCode,
            Duration = duration,
            StdoutBytes = stdoutCounter.Total,
            StderrBytes = stderrCounter.Total,
            TimedOut = timedOut,
        };
    }

    private static bool IsPowerShellKind(ShellKind kind) => kind is ShellKind.PowerShell or ShellKind.Pwsh;

    private static string ExtensionFor(ShellKind kind) => kind switch
    {
        ShellKind.PowerShell or ShellKind.Pwsh => ".ps1",
        ShellKind.Cmd => ".cmd",
        ShellKind.Bash or ShellKind.Sh => ".sh",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported shell kind."),
    };

    private static void EmitLines(
        ReadOnlySequence<byte> buffer,
        StringBuilder lineBuilder,
        RunContext ctx,
        ShellStream streamKind,
        IEventBus bus)
    {
        // Decode incrementally as UTF-8 (good enough for line splitting; multi-byte chars
        // that straddle reads are rare for shell output and acceptable for the projector
        // stand-in. Real LineProjector (job 15) will handle this exactly.)
        var text = Encoding.UTF8.GetString(buffer);
        foreach (var ch in text)
        {
            if (ch == '\n')
            {
                var line = lineBuilder.ToString();
                _ = lineBuilder.Clear();

                // Trim trailing CR for Windows-style line endings.
                if (line.Length > 0 && line[^1] == '\r')
                {
                    line = line[..^1];
                }

                _ = bus.PublishAsync(
                    new ShellLineEmitted
                    {
                        JobId = ctx.JobId,
                        RunId = ctx.RunId,
                        Stream = streamKind,
                        Line = line,
                    },
                    CancellationToken.None);
            }
            else
            {
                _ = lineBuilder.Append(ch);
            }
        }
    }

    private (string Executable, ImmutableArray<string> Args) BuildArgv(ShellKind kind, Models.Paths.AbsolutePath scriptPath)
    {
        return kind switch
        {
            ShellKind.PowerShell => ("powershell", this.psBuilder.Build(scriptPath)),
            ShellKind.Pwsh => ("pwsh", this.psBuilder.Build(scriptPath)),
            ShellKind.Cmd => ("cmd.exe", ImmutableArray.Create("/d", "/c", scriptPath.Value)),
            ShellKind.Bash => ("bash", ImmutableArray.Create(scriptPath.Value)),
            ShellKind.Sh => ("sh", ImmutableArray.Create(scriptPath.Value)),
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported shell kind."),
        };
    }

    private async Task PumpStreamAsync(
        PipeReader reader,
        ByteCountingPumpResult counter,
        ShellSpec spec,
        RunContext ctx,
        ShellStream streamKind,
        CancellationToken ct)
    {
        var lineBuilder = spec.CaptureStdoutToLineView ? new StringBuilder() : null;

        try
        {
            while (true)
            {
                ReadResult read;
                try
                {
                    read = await reader.ReadAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (IOException)
                {
                    break;
                }

                var buffer = read.Buffer;
                counter.Add(buffer.Length);

                if (lineBuilder is not null)
                {
                    EmitLines(buffer, lineBuilder, ctx, streamKind, this.bus);
                }

                reader.AdvanceTo(buffer.End);

                if (read.IsCompleted)
                {
                    break;
                }
            }

            if (lineBuilder is { Length: > 0 })
            {
                await this.bus.PublishAsync(
                    new ShellLineEmitted
                    {
                        JobId = ctx.JobId,
                        RunId = ctx.RunId,
                        Stream = streamKind,
                        Line = lineBuilder.ToString(),
                    },
                    CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            await reader.CompleteAsync().ConfigureAwait(false);
        }
    }

    private sealed class ByteCountingPumpResult
    {
        private long total;

        public long Total => System.Threading.Interlocked.Read(ref this.total);

        public void Add(long n) => System.Threading.Interlocked.Add(ref this.total, n);
    }
}
