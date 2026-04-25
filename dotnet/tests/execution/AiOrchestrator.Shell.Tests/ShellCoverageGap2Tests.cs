// <copyright file="ShellCoverageGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.Eventing;
using AiOrchestrator.Shell.Exceptions;
using AiOrchestrator.Shell.Tests.Fakes;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Targeted coverage-gap tests for Shell assembly (~8 lines).</summary>
public sealed class ShellCoverageGap2Tests
{
    // ================================================================
    // ShellRunner — PowerShell vs Pwsh argv construction
    // ================================================================

    [Fact]
    public async Task ShellRunner_PowerShell_UsesCorrectExecutable()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.PowerShell, "Get-Date");
        harness.Spawner.OnSpawn = h => h.Complete(0);

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        Assert.Equal("powershell", processSpec.Executable);
        Assert.EndsWith(".ps1", processSpec.Arguments[^1]);
    }

    // ================================================================
    // ShellRunner — working directory missing throws
    // ================================================================

    [Fact]
    public async Task ShellRunner_WorkingDirNotExist_Throws()
    {
        var harness = new ShellRunnerHarness();
        // Create a spec without adding the working directory to the fake filesystem
        var spec = new ShellSpec
        {
            Shell = ShellKind.Bash,
            Script = "echo test",
            WorkingDirectory = new AbsolutePath("/nonexistent/path"),
            Env = ImmutableDictionary<string, string>.Empty,
            Timeout = null,
            CaptureStdoutToLineView = false,
        };

        await Assert.ThrowsAsync<WorkingDirectoryNotFoundException>(async () =>
            await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None));
    }

    // ================================================================
    // ShellRunner — Windows-style line endings (CRLF) trimmed
    // ================================================================

    [Fact]
    public async Task ShellRunner_CrlfLineEndings_AreNormalized()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(capture: true);

        harness.Spawner.OnSpawn = h =>
        {
            _ = h.WriteStdoutAsync(Encoding.UTF8.GetBytes("line1\r\nline2\r\n")).AsTask()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var lines = harness.Bus.Published.OfType<ShellLineEmitted>()
            .Where(e => e.Stream == ShellStream.Stdout)
            .Select(e => e.Line)
            .ToList();
        Assert.Equal(2, lines.Count);
        Assert.Equal("line1", lines[0]); // CR should be trimmed
        Assert.Equal("line2", lines[1]);
    }

    // ================================================================
    // ShellRunResult — property roundtrip
    // ================================================================

    [Fact]
    public void ShellRunResult_Properties_Roundtrip()
    {
        var result = new ShellRunResult
        {
            ExitCode = 1,
            Duration = TimeSpan.FromSeconds(5),
            StdoutBytes = 100,
            StderrBytes = 50,
            TimedOut = true,
        };

        Assert.Equal(1, result.ExitCode);
        Assert.Equal(TimeSpan.FromSeconds(5), result.Duration);
        Assert.Equal(100, result.StdoutBytes);
        Assert.Equal(50, result.StderrBytes);
        Assert.True(result.TimedOut);
    }

    // ================================================================
    // WorkingDirectoryNotFoundException — constructors
    // ================================================================

    [Fact]
    public void WorkingDirectoryNotFoundException_MessageCtor()
    {
        var ex = new WorkingDirectoryNotFoundException("/missing");
        Assert.Contains("/missing", ex.Message);
    }
}
