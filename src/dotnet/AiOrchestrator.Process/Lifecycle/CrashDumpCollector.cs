// <copyright file="CrashDumpCollector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Process.Lifecycle;

/// <summary>
/// Default implementation of <see cref="IProcessLifecycle"/> that writes crash dumps
/// on Windows via <c>MiniDumpWriteDump</c> and on Linux by reading core dump files
/// from the OS-configured core dump path.
/// </summary>
public sealed class CrashDumpCollector : IProcessLifecycle
{
    private readonly ILogger<CrashDumpCollector> logger;

    /// <summary>Initializes a new instance of the <see cref="CrashDumpCollector"/> class.</summary>
    /// <param name="logger">Logger for diagnostics.</param>
    public CrashDumpCollector(ILogger<CrashDumpCollector> logger)
    {
        this.logger = logger;
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
                await CaptureLinuxDumpAsync(pid, outputPath, ct).ConfigureAwait(false);
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
        await using var fileStream = new FileStream(outputPath.Value, FileMode.Create, FileAccess.Write, FileShare.None);
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

    private static async ValueTask CaptureLinuxDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct)
    {
        // Try to copy an existing core dump file produced by the kernel
        var corePattern = "/proc/sys/kernel/core_pattern";
        if (File.Exists(corePattern))
        {
            var pattern = (await File.ReadAllTextAsync(corePattern, ct).ConfigureAwait(false)).Trim();
            if (!pattern.StartsWith('|'))
            {
                // Simple path pattern; try common core dump locations
                var coreFile = $"core.{pid}";
                if (File.Exists(coreFile))
                {
                    File.Copy(coreFile, outputPath.Value, overwrite: true);
                    return;
                }

                var coreInTmp = Path.Combine("/tmp", coreFile);
                if (File.Exists(coreInTmp))
                {
                    File.Copy(coreInTmp, outputPath.Value, overwrite: true);
                }
            }
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
