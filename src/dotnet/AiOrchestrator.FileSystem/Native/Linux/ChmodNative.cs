// <copyright file="ChmodNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.FileSystem.Native.Linux;

/// <summary>P/Invoke wrapper around the POSIX <c>chmod(2)</c> system call.</summary>
internal static partial class ChmodNative
{
    /// <summary>Sets POSIX file permissions on <paramref name="path"/> to <paramref name="mode"/>.</summary>
    /// <param name="path">Absolute path to the file.</param>
    /// <param name="mode">Octal permission mode (e.g., <c>0600</c>).</param>
    /// <returns>Zero on success, -1 on error (with <c>errno</c> set).</returns>
    [LibraryImport("libc", EntryPoint = "chmod", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    internal static partial int Chmod(string path, uint mode);
}
