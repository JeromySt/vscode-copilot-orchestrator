// <copyright file="RLimitsLinux.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using AiOrchestrator.Process.Native.Linux;

namespace AiOrchestrator.Process.Limits;

/// <summary>
/// Applies POSIX resource limits via <c>setrlimit(2)</c> for the calling process
/// (called in the forked child before <c>execve</c>, satisfying INV-9).
/// Also attaches the target process to a cgroups v2 slice for memory and CPU enforcement.
/// </summary>
[ExcludeFromCodeCoverage]
internal static class RLimitsLinux
{
    /// <summary>
    /// Applies resource limits to the process identified by <paramref name="pid"/>.
    /// For <c>setrlimit</c> constraints, this must be called from within the target process
    /// (i.e., between fork and exec). The cgroups v2 limits are applied from the parent.
    /// </summary>
    /// <param name="pid">The PID of the process to limit.</param>
    /// <param name="limits">The resource limits to apply.</param>
    internal static void Apply(int pid, ResourceLimits limits)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        ApplyRlimits(limits);
        CGroupV2.Apply(pid, limits);
    }

    /// <summary>Cleans up cgroup slices created for a process after it exits.</summary>
    /// <param name="pid">The PID of the exited process.</param>
    internal static void Cleanup(int pid)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            CGroupV2.Cleanup(pid);
        }
    }

    private static void ApplyRlimits(ResourceLimits limits)
    {
        if (limits.MaxMemoryBytes.HasValue)
        {
            var rl = new SetRlimitNative.RLimit
            {
                RlimCur = (ulong)limits.MaxMemoryBytes.Value,
                RlimMax = (ulong)limits.MaxMemoryBytes.Value,
            };
            _ = SetRlimitNative.SetRlimit(SetRlimitNative.RLIMIT_AS, ref rl);
        }

        if (limits.MaxCpuTime.HasValue)
        {
            var seconds = (ulong)Math.Ceiling(limits.MaxCpuTime.Value.TotalSeconds);
            var rl = new SetRlimitNative.RLimit
            {
                RlimCur = seconds,
                RlimMax = seconds,
            };
            _ = SetRlimitNative.SetRlimit(SetRlimitNative.RLIMIT_CPU, ref rl);
        }

        if (limits.MaxOpenFiles.HasValue)
        {
            var rl = new SetRlimitNative.RLimit
            {
                RlimCur = (ulong)limits.MaxOpenFiles.Value,
                RlimMax = (ulong)limits.MaxOpenFiles.Value,
            };
            _ = SetRlimitNative.SetRlimit(SetRlimitNative.RLIMIT_NOFILE, ref rl);
        }

        if (limits.MaxProcesses.HasValue)
        {
            var rl = new SetRlimitNative.RLimit
            {
                RlimCur = (ulong)limits.MaxProcesses.Value,
                RlimMax = (ulong)limits.MaxProcesses.Value,
            };
            _ = SetRlimitNative.SetRlimit(SetRlimitNative.RLIMIT_NPROC, ref rl);
        }
    }
}
