// <copyright file="ConPtyNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process.Native.Windows;

/// <summary>Provides P/Invoke declarations for the Windows ConPTY (pseudo-console) API.</summary>
internal static partial class ConPtyNative
{
#pragma warning disable SA1310 // Field names should not contain underscores — these match Win32 constant names
    internal const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    internal const uint PSEUDOCONSOLE_INHERIT_CURSOR = 0x01;
#pragma warning restore SA1310

    /// <summary>Creates a pseudo-console.</summary>
    /// <param name="size">The initial size of the console window in character cells.</param>
    /// <param name="hInput">Handle to the read end of the communication pipe.</param>
    /// <param name="hOutput">Handle to the write end of the communication pipe.</param>
    /// <param name="dwFlags">Creation flags.</param>
    /// <param name="phPC">Receives the handle to the pseudo-console.</param>
    /// <returns>S_OK on success.</returns>
    [LibraryImport("kernel32", EntryPoint = "CreatePseudoConsole", SetLastError = false)]
    internal static partial int CreatePseudoConsole(
        Coord size,
        SafeFileHandle hInput,
        SafeFileHandle hOutput,
        uint dwFlags,
        out nint phPC);

    /// <summary>Resizes a pseudo-console to the specified dimensions.</summary>
    /// <param name="hPC">Handle to the pseudo-console.</param>
    /// <param name="size">New dimensions.</param>
    /// <returns>S_OK on success.</returns>
    [LibraryImport("kernel32", EntryPoint = "ResizePseudoConsole", SetLastError = false)]
    internal static partial int ResizePseudoConsole(nint hPC, Coord size);

    /// <summary>Closes a pseudo-console and releases all associated resources.</summary>
    /// <param name="hPC">Handle to the pseudo-console to close.</param>
    [LibraryImport("kernel32", EntryPoint = "ClosePseudoConsole", SetLastError = false)]
    internal static partial void ClosePseudoConsole(nint hPC);

    /// <summary>Represents the COORD structure (column, row).</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct Coord
    {
        internal short X;
        internal short Y;
    }
}
