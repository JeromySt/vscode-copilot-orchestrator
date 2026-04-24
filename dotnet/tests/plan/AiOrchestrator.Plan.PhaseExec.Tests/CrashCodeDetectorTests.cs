// <copyright file="CrashCodeDetectorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Plan.PhaseExec.Healing;
using Xunit;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>Tests for <see cref="CrashCodeDetector"/> covering all Windows and Unix crash codes.</summary>
public sealed class CrashCodeDetectorTests
{
    // ──────────────────────────────────────────────────────────────────────────
    // IsCrashExitCode
    // ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(-1, false)]
    [InlineData(42, false)]
    [InlineData(255, false)]
    public void IsCrashExitCode_NormalExitCodesReturnFalse(int exitCode, bool expected)
    {
        // The result depends on the OS but normal codes should never be crashes
        var result = CrashCodeDetector.IsCrashExitCode(exitCode);
        if (!IsWindowsOrLinux())
        {
            return; // skip on unsupported platforms
        }

        Assert.Equal(expected, result);
    }

    [Fact]
    public void IsCrashExitCode_WindowsCrashCodes()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        // Access Violation
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC0000005)));
        // Stack Overflow
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC00000FD)));
        // Heap Corruption
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC0000374)));
        // Integer Overflow
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC0000095)));
        // Privileged Instruction
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC0000096)));
        // Illegal Instruction
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0xC000001D)));
        // Guard Page Violation
        Assert.True(CrashCodeDetector.IsCrashExitCode(unchecked((int)0x80000001)));
    }

    [Fact]
    public void IsCrashExitCode_UnixSignals()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        Assert.True(CrashCodeDetector.IsCrashExitCode(139));  // SIGSEGV
        Assert.True(CrashCodeDetector.IsCrashExitCode(134));  // SIGABRT
        Assert.True(CrashCodeDetector.IsCrashExitCode(135));  // SIGBUS
        Assert.True(CrashCodeDetector.IsCrashExitCode(136));  // SIGFPE
        Assert.True(CrashCodeDetector.IsCrashExitCode(132));  // SIGILL
        Assert.True(CrashCodeDetector.IsCrashExitCode(137));  // SIGKILL
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DescribeCrash
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void DescribeCrash_NormalExitCode_ReturnsNull()
    {
        Assert.Null(CrashCodeDetector.DescribeCrash(0));
        Assert.Null(CrashCodeDetector.DescribeCrash(1));
        Assert.Null(CrashCodeDetector.DescribeCrash(42));
    }

    [Fact]
    public void DescribeCrash_WindowsCodes_ReturnDescriptions()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        Assert.Contains("Access violation", CrashCodeDetector.DescribeCrash(unchecked((int)0xC0000005)));
        Assert.Contains("Stack overflow", CrashCodeDetector.DescribeCrash(unchecked((int)0xC00000FD)));
        Assert.Contains("Heap corruption", CrashCodeDetector.DescribeCrash(unchecked((int)0xC0000374)));
        Assert.Contains("Integer overflow", CrashCodeDetector.DescribeCrash(unchecked((int)0xC0000095)));
        Assert.Contains("Privileged instruction", CrashCodeDetector.DescribeCrash(unchecked((int)0xC0000096)));
        Assert.Contains("Illegal instruction", CrashCodeDetector.DescribeCrash(unchecked((int)0xC000001D)));
        Assert.Contains("Guard page", CrashCodeDetector.DescribeCrash(unchecked((int)0x80000001)));
    }

    [Fact]
    public void DescribeCrash_UnixSignals_ReturnDescriptions()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        Assert.Contains("Segmentation fault", CrashCodeDetector.DescribeCrash(139));
        Assert.Contains("Abort", CrashCodeDetector.DescribeCrash(134));
        Assert.Contains("Bus error", CrashCodeDetector.DescribeCrash(135));
        Assert.Contains("Floating-point", CrashCodeDetector.DescribeCrash(136));
        Assert.Contains("Illegal instruction", CrashCodeDetector.DescribeCrash(132));
        Assert.Contains("Killed", CrashCodeDetector.DescribeCrash(137));
    }

    private static bool IsWindowsOrLinux()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ||
           RuntimeInformation.IsOSPlatform(OSPlatform.Linux);
}
