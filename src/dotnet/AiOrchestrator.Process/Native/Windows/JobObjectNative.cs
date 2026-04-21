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
