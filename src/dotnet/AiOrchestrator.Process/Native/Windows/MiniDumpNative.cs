// <copyright file="MiniDumpNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Native.Windows;

/// <summary>Provides P/Invoke declarations for <c>MiniDumpWriteDump</c> from DbgHelp.dll.</summary>
internal static partial class MiniDumpNative
{
    /// <summary>Specifies the type of information to include in the minidump.</summary>
    [Flags]
    internal enum MiniDumpType : uint
    {
        /// <summary>Include thread and handle data.</summary>
        Normal = 0x00000000,

        /// <summary>Include full heap memory.</summary>
        WithFullMemory = 0x00000002,

        /// <summary>Include handle data.</summary>
        WithHandleData = 0x00000004,

        /// <summary>Include unloaded modules.</summary>
        WithUnloadedModules = 0x00000020,

        /// <summary>Include indirectly referenced memory.</summary>
        WithIndirectlyReferencedMemory = 0x00000040,
    }

    /// <summary>Writes a minidump to a file for the specified process.</summary>
    /// <param name="hProcess">Handle to the process whose dump to capture.</param>
    /// <param name="processId">Process ID of the process.</param>
    /// <param name="hFile">Handle to the file to write the dump to.</param>
    /// <param name="dumpType">Type of dump to write.</param>
    /// <param name="exceptionParam">Exception information (may be null).</param>
    /// <param name="userStreamParam">User-defined stream (may be null).</param>
    /// <param name="callbackParam">Callback routine (may be null).</param>
    /// <returns><see langword="true"/> on success.</returns>
    [LibraryImport("dbghelp", EntryPoint = "MiniDumpWriteDump", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool MiniDumpWriteDump(
        nint hProcess,
        int processId,
        SafeFileHandle hFile,
        MiniDumpType dumpType,
        nint exceptionParam,
        nint userStreamParam,
        nint callbackParam);
}
