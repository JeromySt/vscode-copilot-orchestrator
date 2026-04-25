// <copyright file="RunnerCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Agent.Runners;
using AiOrchestrator.Agent.Tests.Fakes;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Agent.Tests;

/// <summary>Coverage-gap tests for runner BuildArgs branches, executable locator, and error paths.</summary>
public sealed class RunnerCoverageGapTests
{
    // ---- DefaultExecutableLocator ------------------------------------------

    [Fact]
    public void DefaultExecutableLocator_NullName_Throws()
    {
        var locator = new DefaultExecutableLocator();
        Assert.Throws<ArgumentNullException>(() => locator.Locate(null!));
    }

    [Fact]
    public void DefaultExecutableLocator_EmptyName_Throws()
    {
        var locator = new DefaultExecutableLocator();
        Assert.Throws<ArgumentException>(() => locator.Locate(string.Empty));
    }

    [Fact]
    public void DefaultExecutableLocator_MissingExecutable_ReturnsNull()
    {
        var locator = new DefaultExecutableLocator();
        // Use a name that is very unlikely to exist on any real PATH.
        var result = locator.Locate("orca-nonexistent-exe-" + Guid.NewGuid().ToString("N"));
        Assert.Null(result);
    }

    [Fact]
    public void DefaultExecutableLocator_FindsExecutableInTempDir()
    {
        var locator = new DefaultExecutableLocator();
        var tempDir = Path.Combine(Path.GetTempPath(), "locator-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var exeName = "orca-test-locator-" + Guid.NewGuid().ToString("N");

            if (OperatingSystem.IsWindows())
            {
                // On Windows, we need an .exe extension.
                File.WriteAllText(Path.Combine(tempDir, exeName + ".exe"), "fake");
            }
            else
            {
                File.WriteAllText(Path.Combine(tempDir, exeName), "fake");
            }

            // Temporarily prepend the temp dir to PATH.
            var sep = OperatingSystem.IsWindows() ? ";" : ":";
            var originalPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            Environment.SetEnvironmentVariable("PATH", tempDir + sep + originalPath);
            try
            {
                var result = locator.Locate(exeName);
                Assert.NotNull(result);
                Assert.Contains(exeName, result);
            }
            finally
            {
                Environment.SetEnvironmentVariable("PATH", originalPath);
            }
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    // ---- BuildArgs: Model flag for each runner -----------------------------

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode, "--model")]
    [InlineData(AgentRunnerKind.CodexCli, "--model")]
    [InlineData(AgentRunnerKind.GeminiCli, "--model")]
    [InlineData(AgentRunnerKind.CopilotCli, "--model")]
    [InlineData(AgentRunnerKind.GhCopilot, "--model")]
    [InlineData(AgentRunnerKind.Qwen, "--model")]
    public async Task BuildArgs_ModelFlag_InjectedForAllRunners(AgentRunnerKind kind, string modelFlag)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind) with { Model = "test-model-42" };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains(modelFlag, captured.Arguments);
        Assert.Contains("test-model-42", captured.Arguments);
    }

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    [InlineData(AgentRunnerKind.Qwen)]
    public async Task BuildArgs_NoModel_OmitsModelFlag(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind); // Model is null by default
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.DoesNotContain("--model", captured.Arguments);
    }

    // ---- BuildArgs: AllowedFolders for each supporting runner ---------------

    [Theory]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.Qwen)]
    [InlineData(AgentRunnerKind.CodexCli)]
    public async Task BuildArgs_AllowedFolders_InjectedForSupportingRunners(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var folder = new AbsolutePath("/test/folder");
        var spec = AgentTestHarness.MakeSpec(kind) with
        {
            AllowedFolders = ImmutableArray.Create(folder),
        };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains(captured.Arguments, a => a.Contains(folder.Value, StringComparison.Ordinal));
    }

    // ---- BuildArgs: AllowedUrls for each runner ----------------------------

    [Theory]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.Qwen)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    public async Task BuildArgs_AllowedUrls_InjectedForAllRunners(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind) with
        {
            AllowedUrls = ImmutableArray.Create("https://test.example.com"),
        };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains(captured.Arguments, a => a.Contains("https://test.example.com", StringComparison.Ordinal));
    }

    // ---- BuildArgs: ResumeSession for each runner ---------------------------

    [Theory]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.Qwen)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    public async Task BuildArgs_ResumeSession_InjectedForAllRunners(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind) with
        {
            ResumeSession = true,
            ResumeSessionId = "resume-session-xyz",
        };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains("resume-session-xyz", captured.Arguments);
    }

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode)]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.Qwen)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    public async Task BuildArgs_NoResume_OmitsResumeFlag(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind); // ResumeSession=false by default
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.DoesNotContain("--resume", captured.Arguments);
        Assert.DoesNotContain("--resume-session", captured.Arguments);
    }

    // ---- SandboxUnsupported warning (GhCopilot) ----------------------------

    [Fact]
    public async Task GhCopilot_WithAllowedFolders_SetsSandboxUnsupportedWarning()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.GhCopilot, spawner, clock, locator);

        var folder = new AbsolutePath("/some/path");
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.GhCopilot) with
        {
            AllowedFolders = ImmutableArray.Create(folder),
        };
        spawner.OnSpawn = h => h.Complete(0);

        var result = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        Assert.True(result.SandboxUnsupportedWarning);
    }

    [Fact]
    public async Task GhCopilot_WithoutAllowedFolders_NoSandboxWarning()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.GhCopilot, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.GhCopilot);
        spawner.OnSpawn = h => h.Complete(0);

        var result = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        Assert.False(result.SandboxUnsupportedWarning);
    }

    // ---- Xhigh effort rejection for non-supporting runners ------------------

    [Theory]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.Qwen)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    public async Task XhighEffort_RejectedByNonSupportingRunner(AgentRunnerKind kind)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(kind) with { Effort = Effort.Xhigh };

        var ex = await Assert.ThrowsAsync<ArgumentException>(async () =>
            await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None));

        Assert.Contains("Xhigh", ex.Message);
    }

    [Fact]
    public async Task ClaudeCode_XhighEffort_Accepted()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with { Effort = Effort.Xhigh };
        spawner.OnSpawn = h => h.Complete(0);

        var result = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        Assert.Equal(0, result.ExitCode);
    }

    // ---- ClaudeCode reasoning-effort flag -----------------------------------

    [Theory]
    [InlineData(Effort.Low, "low")]
    [InlineData(Effort.Medium, "medium")]
    [InlineData(Effort.High, "high")]
    [InlineData(Effort.Xhigh, "xhigh")]
    public async Task ClaudeCode_EffortFlag_AppearInArgs(Effort effort, string expectedArg)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with { Effort = effort };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains("--reasoning-effort", captured.Arguments);
        Assert.Contains(expectedArg, captured.Arguments);
    }

    // ---- Constructor null-guard tests for AgentRunnerBase -------------------

    [Fact]
    public void AgentRunnerBase_NullSpawner_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ClaudeCodeRunner(null!, new FakeClock(), new FakeExecutableLocator(), Microsoft.Extensions.Logging.Abstractions.NullLogger<ClaudeCodeRunner>.Instance));
    }

    [Fact]
    public void AgentRunnerBase_NullClock_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ClaudeCodeRunner(new FakeProcessSpawner(), null!, new FakeExecutableLocator(), Microsoft.Extensions.Logging.Abstractions.NullLogger<ClaudeCodeRunner>.Instance));
    }

    [Fact]
    public void AgentRunnerBase_NullLocator_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ClaudeCodeRunner(new FakeProcessSpawner(), new FakeClock(), null!, Microsoft.Extensions.Logging.Abstractions.NullLogger<ClaudeCodeRunner>.Instance));
    }

    [Fact]
    public void AgentRunnerBase_NullLogger_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new ClaudeCodeRunner(new FakeProcessSpawner(), new FakeClock(), new FakeExecutableLocator(), null!));
    }

    // ---- RunAsync null-guard tests ------------------------------------------

    [Fact]
    public async Task RunAsync_NullSpec_Throws()
    {
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, new FakeProcessSpawner(), new FakeClock(), InstallAll());
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await runner.RunAsync(null!, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None));
    }

    [Fact]
    public async Task RunAsync_NullCtx_Throws()
    {
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, new FakeProcessSpawner(), new FakeClock(), InstallAll());
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await runner.RunAsync(AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode), null!, new RecordingSink(), CancellationToken.None));
    }

    [Fact]
    public async Task RunAsync_NullSink_Throws()
    {
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, new FakeProcessSpawner(), new FakeClock(), InstallAll());
        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await runner.RunAsync(AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode), AgentTestHarness.SampleCtx(), null!, CancellationToken.None));
    }

    // ---- Duration is computed correctly ------------------------------------

    [Fact]
    public async Task RunAsync_Duration_IsPositive()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        spawner.OnSpawn = h =>
        {
            clock.Advance(TimeSpan.FromMilliseconds(500));
            h.Complete(0);
        };

        var result = await runner.RunAsync(AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode), AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        Assert.True(result.Duration.TotalMilliseconds >= 500);
    }

    // ---- Env flows through ProcessSpec.Environment --------------------------

    [Fact]
    public async Task RunAsync_Env_FlowsThroughProcessSpec()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        var env = ImmutableDictionary.CreateRange(new[]
        {
            new KeyValuePair<string, string>("MY_KEY", "my_value"),
        });
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with { Env = env };
        spawner.OnSpawn = h => h.Complete(0);

        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.NotNull(captured.Environment);
        Assert.Equal("my_value", captured.Environment!["MY_KEY"]);
    }

    // ---- Runner Kind properties verified -----------------------------------

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    [InlineData(AgentRunnerKind.Qwen)]
    public void Runner_Kind_MatchesExpected(AgentRunnerKind kind)
    {
        var runner = AgentTestHarness.MakeRunner(kind, new FakeProcessSpawner(), new FakeClock(), InstallAll());
        Assert.Equal(kind, runner.Kind);
    }

    // ---- Helpers -----------------------------------------------------------

    private static FakeExecutableLocator InstallAll()
    {
        var locator = new FakeExecutableLocator();
        foreach (var name in new[] { "claude", "codex", "gemini", "copilot", "gh", "qwen" })
        {
            _ = locator.Installed.Add(name);
        }

        return locator;
    }
}
