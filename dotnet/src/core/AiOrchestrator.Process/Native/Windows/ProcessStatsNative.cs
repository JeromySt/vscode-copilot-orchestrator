// <copyright file="ProcessStatsNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Native.Windows;

/// <summary>
/// P/Invoke declarations for lightweight per-PID stats collection on Windows.
/// Uses direct Win32 APIs instead of <c>System.Diagnostics.Process</c> (OE-0005 compliant).
/// </summary>
[ExcludeFromCodeCoverage]
internal static partial class ProcessStatsNative
{
#pragma warning disable SA1310 // Field names should not contain underscores — these match Win32 constant names
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    internal const uint PROCESS_VM_READ = 0x0010;
#pragma warning restore SA1310

    /// <summary>Retrieves timing information for the specified process.</summary>
    [LibraryImport("kernel32", EntryPoint = "GetProcessTimes", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetProcessTimes(
        SafeFileHandle hProcess,
        out long lpCreationTime,
        out long lpExitTime,
        out long lpKernelTime,
        out long lpUserTime);

    /// <summary>Retrieves the full path of the executable for the specified process.</summary>
    [LibraryImport("kernel32", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool QueryFullProcessImageName(
        SafeFileHandle hProcess,
        uint dwFlags,
        char[] lpExeName,
        ref uint lpdwSize);

    /// <summary>Memory counters returned by <c>GetProcessMemoryInfo</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessMemoryCounters
    {
        internal uint Cb;
        internal uint PageFaultCount;
        internal nuint PeakWorkingSetSize;
        internal nuint WorkingSetSize;
        internal nuint QuotaPeakPagedPoolUsage;
        internal nuint QuotaPagedPoolUsage;
        internal nuint QuotaPeakNonPagedPoolUsage;
        internal nuint QuotaNonPagedPoolUsage;
        internal nuint PagefileUsage;
        internal nuint PeakPagefileUsage;
    }

    /// <summary>Retrieves memory usage information for the specified process.</summary>
    [LibraryImport("kernel32", EntryPoint = "K32GetProcessMemoryInfo", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetProcessMemoryInfo(
        SafeFileHandle hProcess,
        ref ProcessMemoryCounters ppsmemCounters,
        uint cb);

    /// <summary>Returns the number of active threads in a process via NtQueryInformationProcess (basic info).</summary>
    [LibraryImport("ntdll", EntryPoint = "NtQueryInformationProcess")]
    internal static partial int NtQueryInformationProcess(
        SafeFileHandle processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        uint processInformationLength,
        out uint returnLength);

    /// <summary>Basic process information from NtQueryInformationProcess.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessBasicInformation
    {
        internal nint ExitStatus;
        internal nint PebBaseAddress;
        internal nint AffinityMask;
        internal nint BasePriority;
        internal nint UniqueProcessId;
        internal nint InheritedFromUniqueProcessId;
    }
}
