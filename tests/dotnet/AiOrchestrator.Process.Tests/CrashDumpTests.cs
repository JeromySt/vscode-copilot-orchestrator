// <copyright file="CrashDumpTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Models;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Tests for crash-dump capture on abnormal process exits (INV-6).</summary>
public sealed class CrashDumpTests
{
    private static readonly FakeProcessLifecycle Lifecycle = new();
    private static readonly FakeClock Clock = new();
    private static readonly FakeTelemetrySink Telemetry = new();

    /// <summary>PROC-6: Crash dump is captured when a process exits via SIGSEGV on Linux.</summary>
    [Fact]
    [ContractTest("PROC-6")]
    public async Task PROC_6_CrashDump_CapturedOnSegfault_Linux()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            // Test only runs on Linux
            return;
        }

        // Build the segfault fixture if available
        var fixtureDir = FindSegfaultFixtureDir();
        if (fixtureDir is null)
        {
            // Fixture directory not found; skip
            return;
        }

        var exePath = Path.Combine(fixtureDir, "segfault");
        if (!File.Exists(exePath))
        {
            // Try to build it
            var buildProc = new System.Diagnostics.Process
            {
                StartInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "gcc",
                    ArgumentList = { "-O0", "-o", exePath, Path.Combine(fixtureDir, "segfault.c") },
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                },
            };

            buildProc.Start();
            await buildProc.WaitForExitAsync();

            if (!File.Exists(exePath))
            {
                // GCC not available; skip
                return;
            }
        }

        var lifecycle = new FakeProcessLifecycle();
        var spawner = new ProcessSpawner(lifecycle, Clock, Telemetry);

        var spec = new ProcessSpec
        {
            Producer = "test",
            Description = "segfault",
            Executable = exePath,
            Arguments = [],
            Environment = null,
        };

        await using var handle = await spawner.SpawnAsync(spec, CancellationToken.None);
        var exitCode = await handle.WaitForExitAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(30));

        // Process crashed — exit code should be non-zero (signal exit)
        exitCode.Should().NotBe(0, "SIGSEGV causes non-zero exit");

        // Wait briefly for the async crash dump capture (fire-and-forget)
        await Task.Delay(TimeSpan.FromSeconds(2));

        // INV-6: crash dump capture was attempted
        lifecycle.Captures.Should().NotBeEmpty(
            "crash dump capture should be triggered on abnormal exit");
    }

    private static string? FindSegfaultFixtureDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "tests", "dotnet",
                "AiOrchestrator.Process.Tests", "Fixtures", "SegfaultFixture");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            // Also try relative from test output dir
            var candidate2 = Path.Combine(dir.FullName, "Fixtures", "SegfaultFixture");
            if (Directory.Exists(candidate2))
            {
                return candidate2;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
