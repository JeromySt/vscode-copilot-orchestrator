// <copyright file="ForkExecNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Process.Native.Linux;

/// <summary>
/// Low-level POSIX helpers for the fork→setrlimit→exec sequence needed to apply
/// resource limits strictly before <c>execve(2)</c> (INV-9).
/// These are used internally by <see cref="Limits.RLimitsLinux"/> to set limits
/// in the forked child before the new image is loaded.
/// </summary>
internal static partial class ForkExecNative
{
    /// <summary>Forks the current process. Returns 0 in the child, child PID in the parent.</summary>
    /// <returns>Child PID in parent, 0 in child, -1 on error.</returns>
    [LibraryImport("libc", EntryPoint = "fork", SetLastError = true)]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int Fork();

    /// <summary>Gets the process ID of the calling process.</summary>
    /// <returns>The current process ID.</returns>
    [LibraryImport("libc", EntryPoint = "getpid")]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int GetPid();

    /// <summary>Waits for any child process to change state.</summary>
    /// <param name="pid">The process ID to wait for (-1 for any child).</param>
    /// <param name="status">Receives the status of the terminated child.</param>
    /// <param name="options">Wait options (WNOHANG = 1, etc.).</param>
    /// <returns>PID of the child, 0 if WNOHANG and no child ready, -1 on error.</returns>
    [LibraryImport("libc", EntryPoint = "waitpid", SetLastError = true)]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int WaitPid(int pid, out int status, int options);
}
