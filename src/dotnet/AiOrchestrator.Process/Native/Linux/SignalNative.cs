// <copyright file="SignalNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Process.Native.Linux;

/// <summary>Provides P/Invoke declarations for POSIX signal delivery.</summary>
internal static partial class SignalNative
{
    internal const int SIGTERM = 15;
    internal const int SIGKILL = 9;
    internal const int SIGINT = 2;

    /// <summary>Sends a signal to a process or process group.</summary>
    /// <param name="pid">Target process ID.</param>
    /// <param name="sig">Signal number.</param>
    /// <returns>Zero on success, -1 on error (errno set).</returns>
    [LibraryImport("libc", EntryPoint = "kill", SetLastError = true)]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int Kill(int pid, int sig);
}
