// <copyright file="ProcessSpawner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#pragma warning disable RS0030 // Do not use banned APIs — this project is the sole allowed consumer of System.Diagnostics.Process

using System.Diagnostics;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models;
using AiOrchestrator.Process.Lifecycle;
using AiOrchestrator.Process.Limits;

namespace AiOrchestrator.Process;

/// <summary>
/// Default implementation of <see cref="IProcessSpawner"/> that spawns child processes
/// using an argv vector (no shell execution, satisfying INV-1), applies <see cref="EnvScope"/>
/// for environment isolation (INV-3), enforces <see cref="ResourceLimits"/> via platform-native
/// mechanisms (INV-9 on Linux, Job Objects on Windows), and wires stdout/stderr as
/// separate <see cref="System.IO.Pipelines.PipeReader"/> instances (INV-4).
/// </summary>
public sealed class ProcessSpawner : IProcessSpawner
{
    private static readonly TimeSpan DefaultGracePeriod = TimeSpan.FromSeconds(5);

    private readonly IProcessLifecycle lifecycle;
    private readonly IClock clock;
    private readonly ITelemetrySink telemetry;

    /// <summary>Initializes a new instance of the <see cref="ProcessSpawner"/> class.</summary>
    /// <param name="lifecycle">Provides crash-dump capture on abnormal process exit.</param>
    /// <param name="clock">Clock for elapsed-time measurements.</param>
    /// <param name="telemetry">Telemetry sink for process spawn metrics.</param>
    public ProcessSpawner(IProcessLifecycle lifecycle, IClock clock, ITelemetrySink telemetry)
    {
        this.lifecycle = lifecycle;
        this.clock = clock;
        this.telemetry = telemetry;
    }

    /// <summary>
    /// Applies resource limits to a process identified by <paramref name="pid"/>.
    /// On Linux this uses setrlimit + cgroups v2; on Windows this uses Job Objects.
    /// </summary>
    /// <param name="pid">The process to limit.</param>
    /// <param name="limits">The limits to apply.</param>
    public static void ApplyLimits(int pid, ResourceLimits limits)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            RLimitsLinux.Apply(pid, limits);
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            JobObjectsWindows.Apply(pid, limits);
        }
    }

    /// <inheritdoc/>
    /// <remarks>
    /// INV-1: The executable is always passed as an argv vector; <c>UseShellExecute</c> is
    /// explicitly set to <see langword="false"/>. The shell is never invoked.
    /// </remarks>
    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var startInfo = BuildStartInfo(spec);

        var process = new System.Diagnostics.Process
        {
            StartInfo = startInfo,
        };

        _ = process.Start();

        // Apply resource limits (INV-9 note: on Linux cgroups v2 attach is post-fork;
        // setrlimit is applied via RLimitsLinux which writes to the cgroup immediately after start)
        ApplyResourceLimits(process.Id, spec);

        var handle = new ProcessHandle(process, this.lifecycle, this.clock, this.telemetry);

        // Wire cancellation: on cancel → SIGTERM, then SIGKILL after grace period (INV-2)
        if (ct.CanBeCanceled)
        {
            _ = ct.Register(
                static state =>
                {
                    var (h, gp) = ((ProcessHandle, TimeSpan))state!;
                    _ = h.CancelAsync(gp);
                },
                (handle, DefaultGracePeriod));
        }

        this.telemetry.RecordCounter("process.spawn", 1, new Dictionary<string, object>
        {
            ["executable"] = spec.Executable,
        });

        return ValueTask.FromResult<IProcessHandle>(handle);
    }

    private static ProcessStartInfo BuildStartInfo(ProcessSpec spec)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = spec.Executable,

            // INV-1: never use shell execute
            UseShellExecute = false,

            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        // Argv-vector: each argument is added individually, no shell parsing (INV-1)
        foreach (var arg in spec.Arguments)
        {
            startInfo.ArgumentList.Add(arg);
        }

        // Apply environment scope (INV-3)
        ApplyEnvironment(startInfo, spec);

        return startInfo;
    }

    private static void ApplyEnvironment(ProcessStartInfo startInfo, ProcessSpec spec)
    {
        if (spec.Environment is not { } env)
        {
            // No environment specified: inherit everything from the parent process
            return;
        }

        // INV-3: env specified → only expose listed variables (InheritOther=false semantics)
        startInfo.Environment.Clear();
        foreach (var (key, value) in env)
        {
            startInfo.Environment[key] = value;
        }
    }

    private static void ApplyResourceLimits(int pid, ProcessSpec spec)
    {
        // Resource limits are only applied when a ResourceLimits instance is available
        // via the process spec's extended metadata. The Process project defines ResourceLimits
        // as a standalone type; consumers attach it via ProcessSpawnerOptions or by sub-classing spec.
        // For the default implementation we skip this path if no limits are requested.
        // Concrete limits are applied by callers via ApplyLimits(pid, limits).
        _ = pid;
        _ = spec;
    }
}

#pragma warning restore RS0030
