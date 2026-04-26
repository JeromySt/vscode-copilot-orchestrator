// <copyright file="PidFileWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.PidFile;

/// <summary>Writes the daemon pid file atomically and detects conflicting live instances.</summary>
internal sealed partial class PidFileWriter
{
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly ILogger<PidFileWriter> logger;

    public PidFileWriter(IFileSystem fs, IClock clock, ILogger<PidFileWriter> logger)
    {
        ArgumentNullException.ThrowIfNull(fs);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(logger);
        this.fs = fs;
        this.clock = clock;
        this.logger = logger;
    }

    public async ValueTask WriteAsync(AbsolutePath path, int pid, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            await this.fs.CreateDirectoryAsync(new AbsolutePath(dir), ct).ConfigureAwait(false);
        }

        var tmpName = path.Value + ".tmp-" + this.clock.MonotonicMilliseconds.ToString(CultureInfo.InvariantCulture);
        var tmp = new AbsolutePath(tmpName);
        await this.fs.WriteAllTextAsync(tmp, pid.ToString(CultureInfo.InvariantCulture) + "\n", ct).ConfigureAwait(false);
        await this.fs.MoveAtomicAsync(tmp, path, ct).ConfigureAwait(false);
        this.logger.LogInformation("Wrote pid {Pid} to {Path}", pid, path.Value);
    }

    public async ValueTask<bool> IsRunningAsync(AbsolutePath path, CancellationToken ct)
    {
        if (!await this.fs.ExistsAsync(path, ct).ConfigureAwait(false))
        {
            return false;
        }

        var text = (await this.fs.ReadAllTextAsync(path, ct).ConfigureAwait(false)).Trim();
        if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var pid))
        {
            return false;
        }

        try
        {
            return IsProcessAlive(pid);
        }
        catch
        {
            return false;
        }
    }

    public async ValueTask AcquireOrThrowAsync(AbsolutePath path, CancellationToken ct)
    {
        if (await this.IsRunningAsync(path, ct).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"A live daemon already holds the pid file at {path.Value}.");
        }

        await this.WriteAsync(path, Environment.ProcessId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Checks whether a process with the given PID is alive, using platform-native
    /// syscalls to avoid a dependency on <c>System.Diagnostics.Process</c>.
    /// </summary>
    private static bool IsProcessAlive(int pid)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var handle = NativeMethods.OpenProcess(0x00100000 /* SYNCHRONIZE */, false, pid);
            if (handle == IntPtr.Zero)
            {
                return false;
            }

            NativeMethods.CloseHandle(handle);
            return true;
        }

        // POSIX: kill(pid, 0) checks existence without sending a signal.
        return NativeMethods.Kill(pid, 0) == 0;
    }

    private static partial class NativeMethods
    {
        [LibraryImport("kernel32.dll", SetLastError = true)]
        public static partial IntPtr OpenProcess(int desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool CloseHandle(IntPtr handle);

        [LibraryImport("libc", EntryPoint = "kill", SetLastError = true)]
        public static partial int Kill(int pid, int sig);
    }
}
