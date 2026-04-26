// <copyright file="ProcNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;

namespace AiOrchestrator.Process.Native.macOS;

/// <summary>
/// P/Invoke declarations for macOS <c>libproc</c> APIs used for process tree enumeration.
/// </summary>
[ExcludeFromCodeCoverage]
internal static partial class ProcNative
{
    /// <summary>
    /// Lists child PIDs of the specified process.
    /// </summary>
    /// <param name="ppid">The parent process ID.</param>
    /// <param name="buffer">Buffer to receive child PIDs.</param>
    /// <param name="byteSize">Size of the buffer in bytes.</param>
    /// <returns>The number of bytes written into the buffer, or 0 on failure.</returns>
    [LibraryImport("libproc", EntryPoint = "proc_listchildpids")]
    internal static partial int ListChildPids(int ppid, int[] buffer, int byteSize);

    /// <summary>
    /// Gets child PIDs for a given parent process on macOS.
    /// </summary>
    /// <param name="ppid">The parent process ID.</param>
    /// <returns>An array of child PIDs.</returns>
    internal static int[] GetChildPids(int ppid)
    {
        const int maxChildren = 256;
        var buffer = new int[maxChildren];
        int bytesReturned = ListChildPids(ppid, buffer, maxChildren * sizeof(int));
        if (bytesReturned <= 0)
        {
            return Array.Empty<int>();
        }

        int count = bytesReturned / sizeof(int);
        var result = new int[count];
        Array.Copy(buffer, result, count);
        return result;
    }
}
