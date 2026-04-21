// <copyright file="MoveFileExNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.FileSystem.Native.Windows;

/// <summary>P/Invoke wrapper around the Win32 <c>MoveFileExW</c> function.</summary>
#pragma warning disable SA1310 // Field names should not contain underscore — Win32 flag names are conventional.
internal static partial class MoveFileExNative
{
    /// <summary>Replace the destination file if it already exists.</summary>
    internal const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;

    /// <summary>Block until the move is fully flushed to disk.</summary>
    internal const uint MOVEFILE_WRITE_THROUGH = 0x00000008;

    /// <summary>Atomically renames or moves a file.</summary>
    /// <param name="existingFileName">Source path.</param>
    /// <param name="newFileName">Destination path.</param>
    /// <param name="flags">Bitwise-OR of MOVEFILE_* flags.</param>
    /// <returns><see langword="true"/> on success; otherwise call <see cref="Marshal.GetLastWin32Error"/>.</returns>
    [LibraryImport("kernel32.dll", EntryPoint = "MoveFileExW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool MoveFileEx(string existingFileName, string newFileName, uint flags);
}
#pragma warning restore SA1310
