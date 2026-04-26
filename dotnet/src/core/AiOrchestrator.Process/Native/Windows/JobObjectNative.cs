// <copyright file="JobObjectNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Native.Windows;

/// <summary>Provides P/Invoke declarations for Windows Job Object APIs.</summary>
internal static partial class JobObjectNative
{
    internal const int JobObjectBasicLimitInformation = 2;
    internal const int JobObjectBasicProcessIdList = 3;
    internal const int JobObjectExtendedLimitInformation = 9;

#pragma warning disable SA1310 // Field names should not contain underscores — these match Win32 constant names
    internal const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    internal const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    internal const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    internal const uint JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004;
#pragma warning restore SA1310

    /// <summary>Creates or opens a named or anonymous job object.</summary>
    [LibraryImport("kernel32", EntryPoint = "CreateJobObjectW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    internal static partial SafeFileHandle CreateJobObject(nint lpJobAttributes, string? lpName);

    /// <summary>Assigns a process to a job object.</summary>
    [LibraryImport("kernel32", EntryPoint = "AssignProcessToJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool AssignProcessToJobObject(SafeFileHandle hJob, nint hProcess);

    /// <summary>Sets information about a job object.</summary>
    [LibraryImport("kernel32", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetInformationJobObject(
        SafeFileHandle hJob,
        int jobObjectInformationClass,
        ref JobObjectExtendedLimitInfo lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    /// <summary>Queries information about a job object.</summary>
    [LibraryImport("kernel32", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool QueryInformationJobObject(
        SafeFileHandle hJob,
        int jobObjectInformationClass,
        nint lpJobObjectInformation,
        uint cbJobObjectInformationLength,
        out uint lpReturnLength);

    /// <summary>
    /// Enumerates process IDs assigned to a job object via <c>JobObjectBasicProcessIdList</c>.
    /// </summary>
    /// <param name="jobHandle">A valid job object handle.</param>
    /// <returns>An array of PIDs currently in the job, or empty if the query fails.</returns>
    internal static int[] GetJobProcessIds(SafeFileHandle jobHandle)
    {
        const int maxPids = 256;
        int bufferSize = 8 + (maxPids * IntPtr.Size); // two uint32s + PID pointer array
        var buffer = Marshal.AllocHGlobal(bufferSize);
        try
        {
            if (!QueryInformationJobObject(jobHandle, JobObjectBasicProcessIdList, buffer, (uint)bufferSize, out _))
            {
                return Array.Empty<int>();
            }

            int count = Marshal.ReadInt32(buffer, 4); // NumberOfProcessIdsInList
            var pids = new int[count];
            for (int i = 0; i < count; i++)
            {
                pids[i] = (int)Marshal.ReadIntPtr(buffer, 8 + (i * IntPtr.Size));
            }

            return pids;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>IO counters for job object extended info.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    /// <summary>Basic limit information for a job object.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInfo
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize;
        internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal nuint Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    /// <summary>Extended limit information for a job object.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInfo
    {
        internal JobObjectBasicLimitInfo BasicLimitInformation;
        internal IoCounters IoInfo;
        internal nuint ProcessMemoryLimit;
        internal nuint JobMemoryLimit;
        internal nuint PeakProcessMemoryUsed;
        internal nuint PeakJobMemoryUsed;
    }
}
