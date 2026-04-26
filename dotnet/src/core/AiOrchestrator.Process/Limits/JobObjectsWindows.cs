// <copyright file="JobObjectsWindows.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using AiOrchestrator.Process.Native.Windows;

namespace AiOrchestrator.Process.Limits;

/// <summary>
/// Applies Windows Job Object resource limits to a newly spawned process.
/// The process is assigned to an anonymous job object, then extended limits
/// are configured to enforce memory, CPU time, and process count constraints.
/// </summary>
internal static class JobObjectsWindows
{
    /// <summary>
    /// Creates a Job Object, assigns <paramref name="pid"/> to it, and applies
    /// all constraints specified in <paramref name="limits"/>.
    /// </summary>
    /// <param name="pid">The process identifier to limit.</param>
    /// <param name="limits">The resource limits to apply.</param>
    internal static void Apply(int pid, ResourceLimits limits)
    {
        using var handle = ApplyAndRetainHandle(pid, limits);
    }

    /// <summary>
    /// Creates a Job Object, assigns <paramref name="pid"/> to it, applies
    /// constraints, and returns the Job Object handle for ongoing process tree queries.
    /// The caller owns the returned handle and must dispose it when done.
    /// </summary>
    /// <param name="pid">The process identifier to limit.</param>
    /// <param name="limits">The resource limits to apply.</param>
    /// <returns>The Job Object handle, or <see langword="null"/> if assignment failed.</returns>
    internal static SafeFileHandle? ApplyAndRetainHandle(int pid, ResourceLimits limits)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return null;
        }

        var job = JobObjectNative.CreateJobObject(0, null);
        if (job.IsInvalid)
        {
            return null;
        }

        using var processHandle = CreateProcessNative.OpenProcess(CreateProcessNative.PROCESS_ALL_ACCESS, false, pid);
        if (processHandle.IsInvalid)
        {
            job.Dispose();
            return null;
        }

        if (!JobObjectNative.AssignProcessToJobObject(job, processHandle.DangerousGetHandle()))
        {
            job.Dispose();
            return null;
        }

        var extInfo = default(JobObjectNative.JobObjectExtendedLimitInfo);
        extInfo.BasicLimitInformation.LimitFlags = 0;

        if (limits.MaxMemoryBytes.HasValue)
        {
            extInfo.BasicLimitInformation.LimitFlags |= JobObjectNative.JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            extInfo.ProcessMemoryLimit = (nuint)limits.MaxMemoryBytes.Value;
        }

        if (limits.MaxCpuTime.HasValue)
        {
            extInfo.BasicLimitInformation.LimitFlags |= JobObjectNative.JOB_OBJECT_LIMIT_JOB_TIME;

            // Time in 100-nanosecond intervals
            extInfo.BasicLimitInformation.PerJobUserTimeLimit =
                (long)(limits.MaxCpuTime.Value.TotalSeconds * 10_000_000);
        }

        if (limits.MaxProcesses.HasValue)
        {
            extInfo.BasicLimitInformation.LimitFlags |= JobObjectNative.JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            extInfo.BasicLimitInformation.ActiveProcessLimit = (uint)limits.MaxProcesses.Value;
        }

        if (extInfo.BasicLimitInformation.LimitFlags != 0)
        {
            _ = JobObjectNative.SetInformationJobObject(
                job,
                JobObjectNative.JobObjectExtendedLimitInformation,
                ref extInfo,
                (uint)Marshal.SizeOf<JobObjectNative.JobObjectExtendedLimitInfo>());
        }

        return job;
    }
}
