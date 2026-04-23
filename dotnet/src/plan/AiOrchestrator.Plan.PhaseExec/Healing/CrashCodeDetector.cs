// <copyright file="CrashCodeDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Plan.PhaseExec.Healing;

/// <summary>
/// Detects Windows and Unix process crash codes from exit codes.
/// </summary>
internal static class CrashCodeDetector
{
    // Windows NTSTATUS crash codes.
    private const uint AccessViolation = 0xC0000005;
    private const uint StackOverflow = 0xC00000FD;
    private const uint HeapCorruption = 0xC0000374;
    private const uint IntegerOverflow = 0xC0000095;
    private const uint PrivilegedInstruction = 0xC0000096;
    private const uint IllegalInstruction = 0xC000001D;
    private const uint GuardPageViolation = 0x80000001;

    // Unix signals that indicate a crash (128 + signal number).
    private const int SigSegv = 139;  // 128 + 11
    private const int SigAbrt = 134;  // 128 + 6
    private const int SigBus = 135;   // 128 + 7
    private const int SigFpe = 136;   // 128 + 8
    private const int SigIll = 132;   // 128 + 4
    private const int SigKill = 137;  // 128 + 9

    /// <summary>
    /// Returns <c>true</c> if the exit code indicates a process crash
    /// (as opposed to a normal non-zero exit from application logic).
    /// </summary>
    /// <param name="exitCode">The process exit code to check.</param>
    /// <returns><c>true</c> if the exit code is a recognized crash code.</returns>
    public static bool IsCrashExitCode(int exitCode)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return IsWindowsCrash(unchecked((uint)exitCode));
        }

        return IsUnixCrash(exitCode);
    }

    /// <summary>
    /// Returns a human-readable description of the crash, or <c>null</c> if not a recognized crash code.
    /// </summary>
    /// <param name="exitCode">The process exit code to describe.</param>
    /// <returns>A description of the crash, or <c>null</c>.</returns>
    public static string? DescribeCrash(int exitCode)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return unchecked((uint)exitCode) switch
            {
                AccessViolation => "Access violation (SIGSEGV equivalent, 0xC0000005)",
                StackOverflow => "Stack overflow (0xC00000FD)",
                HeapCorruption => "Heap corruption (0xC0000374)",
                IntegerOverflow => "Integer overflow (0xC0000095)",
                PrivilegedInstruction => "Privileged instruction (0xC0000096)",
                IllegalInstruction => "Illegal instruction (0xC000001D)",
                GuardPageViolation => "Guard page violation (0x80000001)",
                _ => null,
            };
        }

        return exitCode switch
        {
            SigSegv => "Segmentation fault (SIGSEGV, signal 11)",
            SigAbrt => "Abort (SIGABRT, signal 6)",
            SigBus => "Bus error (SIGBUS, signal 7)",
            SigFpe => "Floating-point exception (SIGFPE, signal 8)",
            SigIll => "Illegal instruction (SIGILL, signal 4)",
            SigKill => "Killed (SIGKILL, signal 9)",
            _ => null,
        };
    }

    private static bool IsWindowsCrash(uint exitCode) =>
        exitCode is AccessViolation or StackOverflow or HeapCorruption
            or IntegerOverflow or PrivilegedInstruction or IllegalInstruction
            or GuardPageViolation;

    private static bool IsUnixCrash(int exitCode) =>
        exitCode is SigSegv or SigAbrt or SigBus or SigFpe or SigIll or SigKill;
}
