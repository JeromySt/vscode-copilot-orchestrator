// <copyright file="CreateProcessNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Native.Windows;

/// <summary>Provides P/Invoke declarations for <c>CreateProcess</c> and related process APIs.</summary>
internal static partial class CreateProcessNative
{
#pragma warning disable SA1310 // Field names should not contain underscores — these match Win32 constant names
    internal const uint CREATE_SUSPENDED = 0x00000004;
    internal const uint CREATE_NO_WINDOW = 0x08000000;
    internal const uint PROCESS_ALL_ACCESS = 0x001FFFFF;
#pragma warning restore SA1310

    /// <summary>Duplicates an object handle.</summary>
    [LibraryImport("kernel32", EntryPoint = "DuplicateHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool DuplicateHandle(
        nint hSourceProcessHandle,
        nint hSourceHandle,
        nint hTargetProcessHandle,
        out nint lpTargetHandle,
        uint dwDesiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
        uint dwOptions);

    /// <summary>Returns a pseudohandle for the current process.</summary>
    [LibraryImport("kernel32", EntryPoint = "GetCurrentProcess")]
    internal static partial nint GetCurrentProcess();

    /// <summary>Opens an existing local process object.</summary>
    [LibraryImport("kernel32", EntryPoint = "OpenProcess", SetLastError = true)]
    internal static partial SafeFileHandle OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, int dwProcessId);

    /// <summary>Terminates a process and all its threads.</summary>
    [LibraryImport("kernel32", EntryPoint = "TerminateProcess", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool TerminateProcess(SafeFileHandle hProcess, uint uExitCode);

    /// <summary>Generates a CTRL+C or CTRL+BREAK signal for a console process group.</summary>
    [LibraryImport("kernel32", EntryPoint = "GenerateConsoleCtrlEvent", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, int dwProcessGroupId);
}
