// <copyright file="OpenNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.FileSystem.Native.Linux;

/// <summary>P/Invoke wrapper around the POSIX <c>open(2)</c> system call.</summary>
#pragma warning disable SA1310 // Field names should not contain underscore — POSIX flag names are conventional.
internal static partial class OpenNative
{
    /// <summary>O_RDONLY: Open for reading only.</summary>
    internal const int O_RDONLY = 0x0000;

    /// <summary>O_WRONLY: Open for writing only.</summary>
    internal const int O_WRONLY = 0x0001;

    /// <summary>O_RDWR: Open for reading and writing.</summary>
    internal const int O_RDWR = 0x0002;

    /// <summary>O_CREAT: Create file if it does not exist.</summary>
    internal const int O_CREAT = 0x0040;

    /// <summary>O_EXCL: Fail if file already exists (with O_CREAT).</summary>
    internal const int O_EXCL = 0x0080;

    /// <summary>O_TRUNC: Truncate file to zero length on open.</summary>
    internal const int O_TRUNC = 0x0200;

    /// <summary>O_CLOEXEC: Set the close-on-exec flag.</summary>
    internal const int O_CLOEXEC = 0x080000;

    /// <summary>Opens <paramref name="path"/> with the given <paramref name="flags"/> and <paramref name="mode"/>.</summary>
    /// <param name="path">Absolute path to the file.</param>
    /// <param name="flags">Bitwise-OR of the O_* flags.</param>
    /// <param name="mode">POSIX permission mode (only honored when O_CREAT is set).</param>
    /// <returns>The file descriptor on success, -1 on error (with <c>errno</c> set).</returns>
    [LibraryImport("libc", EntryPoint = "open", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    internal static partial int Open(string path, int flags, uint mode);

    /// <summary>Closes the given file descriptor.</summary>
    /// <param name="fd">The descriptor to close.</param>
    /// <returns>Zero on success, -1 on error.</returns>
    [LibraryImport("libc", EntryPoint = "close", SetLastError = true)]
    internal static partial int Close(int fd);
}
#pragma warning restore SA1310
