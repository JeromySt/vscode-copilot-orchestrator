// <copyright file="SetRlimitNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Process.Native.Linux;

/// <summary>Provides P/Invoke declarations for <c>setrlimit(2)</c>.</summary>
internal static partial class SetRlimitNative
{
#pragma warning disable SA1310 // Field names should not contain underscores — these match POSIX constant names
    internal const int RLIMIT_CPU = 0;
    internal const int RLIMIT_AS = 9;
    internal const int RLIMIT_NOFILE = 7;
    internal const int RLIMIT_NPROC = 6;
    internal const ulong RLIM_INFINITY = ulong.MaxValue;
#pragma warning restore SA1310

    /// <summary>Sets resource limits for the calling process (or a child before exec).</summary>
    /// <param name="resource">Resource identifier constant (RLIMIT_*).</param>
    /// <param name="rlim">Pointer to the new limits.</param>
    /// <returns>Zero on success, -1 on error.</returns>
    [LibraryImport("libc", EntryPoint = "setrlimit", SetLastError = true)]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int SetRlimit(int resource, ref RLimit rlim);

    /// <summary>Gets current resource limits for the calling process.</summary>
    /// <param name="resource">Resource identifier constant (RLIMIT_*).</param>
    /// <param name="rlim">Receives the current limits.</param>
    /// <returns>Zero on success, -1 on error.</returns>
    [LibraryImport("libc", EntryPoint = "getrlimit", SetLastError = true)]
    [UnmanagedCallConv(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    internal static partial int GetRlimit(int resource, out RLimit rlim);

    /// <summary>Represents the <c>struct rlimit</c> layout.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct RLimit
    {
        /// <summary>Soft limit (current effective limit).</summary>
        internal ulong RlimCur;

        /// <summary>Hard limit (ceiling for soft limit).</summary>
        internal ulong RlimMax;
    }
}
