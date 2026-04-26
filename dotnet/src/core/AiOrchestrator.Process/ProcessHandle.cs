// <copyright file="ProcessHandle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.IO.Pipelines;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Process.Lifecycle;
using AiOrchestrator.Process.Limits;
using AiOrchestrator.Process.Native.Linux;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process;

/// <summary>
/// Represents a handle to a running child process spawned by <see cref="ProcessSpawner"/>.
/// Provides access to stdio streams as <see cref="PipeReader"/>/<see cref="PipeWriter"/> instances
/// and manages the process lifetime including graceful cancellation (INV-2).
/// </summary>
public sealed class ProcessHandle : IProcessHandle
{
    private static readonly TimeSpan DefaultGracePeriod = TimeSpan.FromSeconds(5);
    private static readonly AbsolutePath DefaultDumpDir = new(
        RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\dumps" : "/tmp/dumps");

    private readonly System.Diagnostics.Process process;
    private readonly IProcessLifecycle lifecycle;
    private readonly IClock clock;
    private readonly ITelemetrySink telemetry;
    private readonly IFileSystem fs;
    private readonly Pipe stdoutPipe = new();
    private readonly Pipe stderrPipe = new();
    private readonly Pipe stdinPipe = new();
    private readonly TaskCompletionSource<int> exitTcs =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private readonly CancellationTokenSource pumpCts = new();
    private int disposed;

    // Process tree monitoring — lazy, cached
    private SafeFileHandle? jobObjectHandle; // Windows: retained for PID enumeration
    private ProcessTreeNode? cachedTree;
    private long cacheTimestamp;
    private const long CacheTtlMs = 1000;

    /// <summary>
    /// Initializes a new instance of the <see cref="ProcessHandle"/> class.
    /// </summary>
    /// <param name="process">The started process.</param>
    /// <param name="lifecycle">Lifecycle handler for crash-dump capture.</param>
    /// <param name="clock">Clock for elapsed-time measurements.</param>
    /// <param name="telemetry">Telemetry sink for metrics.</param>
    /// <param name="fs">Filesystem abstraction for I/O operations.</param>
    internal ProcessHandle(
        System.Diagnostics.Process process,
        IProcessLifecycle lifecycle,
        IClock clock,
        ITelemetrySink telemetry,
        IFileSystem fs)
    {
        this.process = process;
        this.lifecycle = lifecycle;
        this.clock = clock;
        this.telemetry = telemetry;
        this.fs = fs;

        this.process.EnableRaisingEvents = true;
        this.process.Exited += this.OnProcessExited;

        // Start async pumps for stdout and stderr (INV-4)
        _ = PumpStreamAsync(this.process.StandardOutput.BaseStream, this.stdoutPipe.Writer, this.pumpCts.Token);
        _ = PumpStreamAsync(this.process.StandardError.BaseStream, this.stderrPipe.Writer, this.pumpCts.Token);
        _ = PumpStdinAsync(this.stdinPipe.Reader, this.process.StandardInput.BaseStream, this.pumpCts.Token);
    }

    /// <inheritdoc/>
    public int ProcessId => this.process.Id;

    /// <inheritdoc/>
    public PipeReader StandardOut => this.stdoutPipe.Reader;

    /// <inheritdoc/>
    public PipeReader StandardError => this.stderrPipe.Reader;

    /// <inheritdoc/>
    public PipeWriter StandardIn => this.stdinPipe.Writer;

    /// <inheritdoc/>
    public Task<int> WaitForExitAsync(CancellationToken ct)
    {
        // INV-5: multi-shot — multiple callers await the same underlying Task
        if (!ct.CanBeCanceled)
        {
            return this.exitTcs.Task;
        }

        return this.exitTcs.Task.WaitAsync(ct);
    }

    /// <inheritdoc/>
    public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            this.SendSignalWindows(signal);
        }
        else
        {
            this.SendSignalUnix(signal);
        }

        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Sets the Job Object handle for process tree enumeration on Windows.
    /// Called by <see cref="ProcessSpawner"/> after applying resource limits.
    /// </summary>
    /// <param name="handle">The retained Job Object handle.</param>
    internal void SetJobObjectHandle(SafeFileHandle handle) => this.jobObjectHandle = handle;

    /// <inheritdoc/>
    public async ValueTask<ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct)
    {
        if (this.process.HasExited)
        {
            return null;
        }

        // Check cache
        long nowMs = this.clock.MonotonicMilliseconds;
        if (this.cachedTree is not null && (nowMs - this.cacheTimestamp) < CacheTtlMs)
        {
            return this.cachedTree;
        }

        ProcessTreeNode? tree;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            tree = this.jobObjectHandle is not null
                ? ProcessTreeBuilder.BuildFromJobObject(this.jobObjectHandle, this.ProcessId)
                : null;
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            tree = await ProcessTreeBuilder.BuildFromCgroupAsync(this.ProcessId, this.fs, ct).ConfigureAwait(false);
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            tree = ProcessTreeBuilder.BuildFromProcListChildPids(this.ProcessId);
        }
        else
        {
            tree = null;
        }

        this.cachedTree = tree;
        this.cacheTimestamp = nowMs;
        return tree;
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        // INV-8: idempotent
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        await this.pumpCts.CancelAsync().ConfigureAwait(false);
        this.pumpCts.Dispose();

        // Force-kill if still alive (INV-8)
        try
        {
            if (!this.process.HasExited)
            {
                this.process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort
        }

        this.process.Dispose();

        // Dispose Job Object handle (Windows)
        this.jobObjectHandle?.Dispose();
        this.jobObjectHandle = null;

        this.stdoutPipe.Writer.Complete();
        this.stderrPipe.Writer.Complete();
        this.stdinPipe.Reader.Complete();
    }

    /// <summary>
    /// Initiates graceful cancellation: SIGTERM (or CTRL_BREAK on Windows),
    /// then after the grace period, SIGKILL / TerminateProcess.
    /// </summary>
    /// <param name="gracePeriod">How long to wait after the first signal before force-killing.</param>
    internal async Task CancelAsync(TimeSpan gracePeriod)
    {
        try
        {
            if (this.process.HasExited)
            {
                return;
            }

            // First signal: SIGTERM / CTRL_BREAK
            await this.SignalAsync(ProcessSignal.Terminate, CancellationToken.None).ConfigureAwait(false);

            // Wait for graceful exit
            using var graceCts = new CancellationTokenSource(gracePeriod);
            try
            {
                _ = await this.WaitForExitAsync(graceCts.Token).ConfigureAwait(false);
                return; // Exited gracefully
            }
            catch (OperationCanceledException)
            {
                // Grace period expired — fall through to SIGKILL
            }

            // Force kill (INV-2)
            if (!this.process.HasExited)
            {
                await this.SignalAsync(ProcessSignal.Kill, CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch
        {
            // Best effort — do not let cancellation failures propagate
        }
    }

    private static async Task PumpStreamAsync(Stream source, PipeWriter writer, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var memory = writer.GetMemory(4096);
                var bytesRead = await source.ReadAsync(memory, ct).ConfigureAwait(false);
                if (bytesRead == 0)
                {
                    break;
                }

                writer.Advance(bytesRead);
                var flushResult = await writer.FlushAsync(ct).ConfigureAwait(false);
                if (flushResult.IsCompleted || flushResult.IsCanceled)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal on shutdown
        }
        catch (Exception ex)
        {
            writer.Complete(ex);
            return;
        }

        writer.Complete();
    }

    private static async Task PumpStdinAsync(PipeReader reader, Stream destination, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var readResult = await reader.ReadAsync(ct).ConfigureAwait(false);
                var buffer = readResult.Buffer;

                foreach (var segment in buffer)
                {
                    await destination.WriteAsync(segment, ct).ConfigureAwait(false);
                }

                reader.AdvanceTo(buffer.End);

                if (readResult.IsCompleted || readResult.IsCanceled)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal on shutdown
        }
        catch
        {
            // Destination closed; stop pumping
        }
    }

    private void OnProcessExited(object? sender, EventArgs e)
    {
        var exitCode = this.process.ExitCode;

        // Flush pipes on exit (INV-4)
        this.stdoutPipe.Writer.Complete();
        this.stderrPipe.Writer.Complete();

        // INV-6: capture crash dump on abnormal exit (negative exit codes or signal exits)
        if (exitCode != 0)
        {
            var dumpPath = DefaultDumpDir.Combine(
                new Models.Paths.RelativePath($"crash-{this.ProcessId}-{this.clock.MonotonicMilliseconds}.dmp"));

            _ = this.CaptureCrashDumpFireAndForget(this.ProcessId, dumpPath);
        }

        // INV-9 cleanup: remove cgroup slice
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            _ = RLimitsLinux.CleanupAsync(this.ProcessId, this.fs, CancellationToken.None);
        }

        this.telemetry.RecordCounter("process.exit", 1, new Dictionary<string, object>
        {
            ["exit_code"] = exitCode,
        });

        _ = this.exitTcs.TrySetResult(exitCode);
    }

    private async Task CaptureCrashDumpFireAndForget(int pid, AbsolutePath dumpPath)
    {
        try
        {
            await this.fs.CreateDirectoryAsync(
                new AbsolutePath(Path.GetDirectoryName(dumpPath.Value)!),
                CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            return;
        }

        await this.lifecycle.CaptureCrashDumpAsync(pid, dumpPath, CancellationToken.None).ConfigureAwait(false);
    }

    private void SendSignalUnix(ProcessSignal signal)
    {
        var signum = signal switch
        {
            ProcessSignal.Terminate => SignalNative.SIGTERM,
            ProcessSignal.Kill => SignalNative.SIGKILL,
            ProcessSignal.Interrupt => SignalNative.SIGINT,
            _ => SignalNative.SIGTERM,
        };

        _ = SignalNative.Kill(this.process.Id, signum);
    }

    private void SendSignalWindows(ProcessSignal signal)
    {
        switch (signal)
        {
            case ProcessSignal.Kill:
                try
                {
                    this.process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Process may have already exited
                }

                break;

            case ProcessSignal.Terminate:
            case ProcessSignal.Interrupt:
                // Send CTRL_BREAK_EVENT (0x01) to the process's console group
                _ = CreateProcessNative.GenerateConsoleCtrlEvent(0x01, this.process.Id);
                break;
        }
    }
}
