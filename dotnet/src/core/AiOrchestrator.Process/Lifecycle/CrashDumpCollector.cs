// <copyright file="CrashDumpCollector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Process.Lifecycle;

/// <summary>
/// Default implementation of <see cref="IProcessLifecycle"/> that writes crash dumps
/// on Windows via <c>MiniDumpWriteDump</c> and on Linux by reading core dump files
/// from the OS-configured core dump path.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class CrashDumpCollector : IProcessLifecycle
{
    private readonly ILogger<CrashDumpCollector> logger;
    private readonly IFileSystem fs;

    /// <summary>Initializes a new instance of the <see cref="CrashDumpCollector"/> class.</summary>
    /// <param name="logger">Logger for diagnostics.</param>
    /// <param name="fs">Filesystem abstraction for I/O operations.</param>
    public CrashDumpCollector(ILogger<CrashDumpCollector> logger, IFileSystem fs)
    {
        this.logger = logger;
        this.fs = fs;
    }

    /// <inheritdoc/>
    public async ValueTask CaptureCrashDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct)
    {
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                await CaptureWindowsDumpAsync(pid, outputPath, ct).ConfigureAwait(false);
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                await this.CaptureLinuxDumpAsync(pid, outputPath, ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            // INV-6: failure to capture is logged but not thrown
            this.logger.LogWarning(ex, "Failed to capture crash dump for PID {Pid} at {OutputPath}", pid, outputPath.Value);
        }
    }

    private static async ValueTask CaptureWindowsDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct)
    {
        // MiniDumpWriteDump requires a native SafeFileHandle — FileStream is the only way to get one.
#pragma warning disable OE0004 // Native P/Invoke requires SafeFileHandle from FileStream
        await using var fileStream = new FileStream(outputPath.Value, FileMode.Create, FileAccess.Write, FileShare.None);
#pragma warning restore OE0004
        using var processHandle = CreateProcessNative.OpenProcess(CreateProcessNative.PROCESS_ALL_ACCESS, false, pid);

        if (!processHandle.IsInvalid)
        {
            _ = MiniDumpNative.MiniDumpWriteDump(
                processHandle.DangerousGetHandle(),
                pid,
                fileStream.SafeFileHandle,
                MiniDumpNative.MiniDumpType.WithFullMemory,
                nint.Zero,
                nint.Zero,
                nint.Zero);
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private async ValueTask CaptureLinuxDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct)
    {
        // Try to copy an existing core dump file produced by the kernel
        var corePatternPath = new AbsolutePath("/proc/sys/kernel/core_pattern");
        if (await this.fs.FileExistsAsync(corePatternPath, ct).ConfigureAwait(false))
        {
            var pattern = (await this.fs.ReadAllTextAsync(corePatternPath, ct).ConfigureAwait(false)).Trim();
            if (!pattern.StartsWith('|'))
            {
                // Simple path pattern; try common core dump locations
                var coreFile = $"core.{pid}";
                var coreFilePath = new AbsolutePath(Path.GetFullPath(coreFile));
                if (await this.fs.FileExistsAsync(coreFilePath, ct).ConfigureAwait(false))
                {
                    await this.fs.CopyAsync(coreFilePath, outputPath, overwrite: true, ct).ConfigureAwait(false);
                    return;
                }

                var coreInTmpPath = new AbsolutePath(Path.Combine("/tmp", coreFile));
                if (await this.fs.FileExistsAsync(coreInTmpPath, ct).ConfigureAwait(false))
                {
                    await this.fs.CopyAsync(coreInTmpPath, outputPath, overwrite: true, ct).ConfigureAwait(false);
                }
            }
        }
    }
}
