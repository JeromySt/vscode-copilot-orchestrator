// <copyright file="PidFileWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.PidFile;

/// <summary>Writes the daemon pid file atomically and detects conflicting live instances.</summary>
internal sealed class PidFileWriter
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
            Directory.CreateDirectory(dir);
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
            using var proc = Process.GetProcessById(pid);
            return !proc.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
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
}
