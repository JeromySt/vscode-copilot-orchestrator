// <copyright file="RunnerContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Agent.Runners;
using AiOrchestrator.Agent.Tests.Fakes;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Agent.Tests;

/// <summary>Contract tests for Job 025 — Agent Runners.</summary>
public sealed class RunnerContractTests
{
    [Fact]
    [ContractTest("RUNNER-DISTINCT")]
    public async Task RUNNER_DISTINCT_CopilotVsGhCopilotResolveDifferentExecutables()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = new FakeExecutableLocator();
        _ = locator.Installed.Add("copilot");
        _ = locator.Installed.Add("gh");

        var copilot = AgentTestHarness.MakeRunner(AgentRunnerKind.CopilotCli, spawner, clock, locator);
        var ghCopilot = AgentTestHarness.MakeRunner(AgentRunnerKind.GhCopilot, spawner, clock, locator);

        spawner.OnSpawn = h => h.Complete(0);

        _ = await copilot.RunAsync(AgentTestHarness.MakeSpec(AgentRunnerKind.CopilotCli), AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);
        _ = await ghCopilot.RunAsync(AgentTestHarness.MakeSpec(AgentRunnerKind.GhCopilot), AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var specs = spawner.SpawnedSpecs.ToArray();
        Assert.Equal(2, specs.Length);
        Assert.EndsWith("copilot", specs[0].Executable, StringComparison.Ordinal);
        Assert.EndsWith("gh", specs[1].Executable, StringComparison.Ordinal);
        Assert.NotEqual(specs[0].Executable, specs[1].Executable);
    }

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode, "abc123-claude-session")]
    [InlineData(AgentRunnerKind.CodexCli, "codex-sess-9999")]
    [InlineData(AgentRunnerKind.GeminiCli, "gemini-run-42")]
    [InlineData(AgentRunnerKind.CopilotCli, "copilot-msft-77")]
    [InlineData(AgentRunnerKind.GhCopilot, "gh-cop-123")]
    [InlineData(AgentRunnerKind.Qwen, "qwen-run-A")]
    [ContractTest("RUNNER-SESSION")]
    public async Task RUNNER_SESSION_IdParsedAndExposed(AgentRunnerKind kind, string expectedId)
    {
        var result = await RunWithFixture(kind, "session.txt");
        Assert.Equal(expectedId, result.RunResult.SessionId);
        Assert.Contains(expectedId, result.Sink.SessionIds);
    }

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    [InlineData(AgentRunnerKind.Qwen)]
    [ContractTest("RUNNER-STATS")]
    public async Task RUNNER_STATS_ParsedFromOutput(AgentRunnerKind kind)
    {
        var result = await RunWithFixture(kind, "stats.txt");
        Assert.NotNull(result.RunResult.Stats);
        Assert.True(result.RunResult.Stats.InputTokens > 0, "INV-5: input tokens parsed");
        Assert.True(result.RunResult.Stats.OutputTokens > 0, "INV-5: output tokens parsed");
    }

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode)]
    [InlineData(AgentRunnerKind.CodexCli)]
    [InlineData(AgentRunnerKind.GeminiCli)]
    [InlineData(AgentRunnerKind.CopilotCli)]
    [InlineData(AgentRunnerKind.GhCopilot)]
    [InlineData(AgentRunnerKind.Qwen)]
    [ContractTest("RUNNER-DONE")]
    public async Task RUNNER_TASKCOMPLETE_EmittedOnce(AgentRunnerKind kind)
    {
        // Fixture sends the done marker twice; the handler must flip exactly once.
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);
        var sink = new RecordingSink();
        var doneLine = File.ReadAllText(FixturePath(kind, "done.txt")).TrimEnd();

        spawner.OnSpawn = h =>
        {
            _ = h.WriteStdoutLineAsync(doneLine).AsTask()
                .ContinueWith(_ => h.WriteStdoutLineAsync(doneLine).AsTask(), TaskScheduler.Default)
                .Unwrap()
                .ContinueWith(_ => h.Complete(0), TaskScheduler.Default);
        };

        var runResult = await runner.RunAsync(
            AgentTestHarness.MakeSpec(kind),
            AgentTestHarness.SampleCtx(),
            sink,
            CancellationToken.None);

        Assert.True(runResult.TaskCompleteEmitted, "INV-6: marker observed");
        Assert.Single(sink.TaskCompletes);
    }

    [Fact]
    [ContractTest("RUNNER-CTX")]
    public async Task RUNNER_CTXPRESSURE_FiresAtThresholds()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);
        var sink = new RecordingSink();

        spawner.OnSpawn = h =>
        {
            _ = Task.Run(async () =>
            {
                await h.WriteStdoutLineAsync("context_pct: 65");
                await h.WriteStdoutLineAsync("context_pct: 70"); // still Rising, no new event
                await h.WriteStdoutLineAsync("context_pct: 82"); // -> High
                await h.WriteStdoutLineAsync("context_pct: 95"); // -> Critical
                h.Complete(0);
            });
        };

        _ = await runner.RunAsync(
            AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode),
            AgentTestHarness.SampleCtx(),
            sink,
            CancellationToken.None);

        var levels = sink.Pressures.Select(p => p.Level).ToArray();
        Assert.Contains(ContextPressureLevel.Rising, levels);
        Assert.Contains(ContextPressureLevel.High, levels);
        Assert.Contains(ContextPressureLevel.Critical, levels);

        // INV-7: fire-once-per-level
        Assert.Equal(1, levels.Count(l => l == ContextPressureLevel.Rising));
        Assert.Equal(1, levels.Count(l => l == ContextPressureLevel.High));
        Assert.Equal(1, levels.Count(l => l == ContextPressureLevel.Critical));
    }

    [Fact]
    [ContractTest("RUNNER-MAXTURNS")]
    public async Task RUNNER_MAXTURNS_KillsOnOverrun()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);
        var sink = new RecordingSink();

        spawner.OnSpawn = h =>
        {
            _ = Task.Run(async () =>
            {
                // Emit a turn that exceeds the cap of 2, then DO NOT complete — runner must kill.
                await h.WriteStdoutLineAsync("turns: 5");
            });
        };

        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with { MaxTurns = 2 };
        var result = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), sink, CancellationToken.None);

        Assert.True(result.MaxTurnsExceeded, "INV-9: overrun flagged");
        var handle = spawner.SpawnedHandles.Single();
        Assert.Contains(ProcessSignal.Terminate, handle.SignalsSent);
    }

    [Fact]
    [ContractTest("RUNNER-ALLOW-FOLDER")]
    public async Task RUNNER_ALLOWEDFOLDERS_FlagInjected()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        var folder = new AbsolutePath(Path.Combine(Path.GetTempPath(), "agent-allowed"));
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with
        {
            AllowedFolders = ImmutableArray.Create(folder),
        };

        spawner.OnSpawn = h => h.Complete(0);
        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains("--allowed-tools", captured.Arguments);
        Assert.Contains(captured.Arguments, a => a.Contains(folder.Value, StringComparison.Ordinal));
    }

    [Fact]
    [ContractTest("RUNNER-ALLOW-URL")]
    public async Task RUNNER_ALLOWEDURLS_FlagInjected()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.CodexCli, spawner, clock, locator);

        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.CodexCli) with
        {
            AllowedUrls = ImmutableArray.Create("https://api.example.com/"),
        };

        spawner.OnSpawn = h => h.Complete(0);
        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains("--allow-url", captured.Arguments);
        Assert.Contains("https://api.example.com/", captured.Arguments);
    }

    [Fact]
    [ContractTest("RUNNER-NOT-INSTALLED")]
    public async Task RUNNER_NOTINSTALLED_ThrowsTypedException()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = new FakeExecutableLocator(); // nothing installed
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        var ex = await Assert.ThrowsAsync<AgentRunnerNotInstalledException>(async () =>
            await runner.RunAsync(
                AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode),
                AgentTestHarness.SampleCtx(),
                new RecordingSink(),
                CancellationToken.None));

        Assert.Equal(AgentRunnerKind.ClaudeCode, ex.Kind);
        Assert.Equal("claude", ex.ProbedPath);
    }

    [Fact]
    [ContractTest("RUNNER-RESUME")]
    public async Task RUNNER_RESUME_SessionIdRoundTrips()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);

        const string sid = "prior-session-xyz";
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode) with
        {
            ResumeSession = true,
            ResumeSessionId = sid,
        };

        spawner.OnSpawn = h => h.Complete(0);
        _ = await runner.RunAsync(spec, AgentTestHarness.SampleCtx(), new RecordingSink(), CancellationToken.None);

        var captured = spawner.SpawnedSpecs.Single();
        Assert.Contains("--resume", captured.Arguments);
        Assert.Contains(sid, captured.Arguments);
    }

    [Fact]
    [ContractTest("RUNNER-FACTORY")]
    public void RUNNER_FACTORY_ResolvesByKind()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();

        var runners = Enum.GetValues<AgentRunnerKind>()
            .Select(k => AgentTestHarness.MakeRunner(k, spawner, clock, locator))
            .ToArray();
        var factory = new AgentRunnerFactory(runners);

        foreach (var kind in Enum.GetValues<AgentRunnerKind>())
        {
            var resolved = factory.Resolve(kind);
            Assert.Equal(kind, resolved.Kind);
        }
    }

    [Fact]
    [ContractTest("RUNNER-PROC")]
    public void RUNNER_NEVER_PROCESS_START_DIRECTLY()
    {
        // Roslyn-style source scan: no file under dotnet/src/execution/AiOrchestrator.Agent may reference Process.Start.
        var agentDir = LocateAgentSourceDir();
        var offenders = new List<string>();
        foreach (var file in Directory.EnumerateFiles(agentDir, "*.cs", SearchOption.AllDirectories))
        {
            var text = File.ReadAllText(file);
            if (text.Contains("System.Diagnostics.Process.Start", StringComparison.Ordinal) ||
                text.Contains("Process.Start(", StringComparison.Ordinal))
            {
                offenders.Add(file);
            }
        }

        Assert.Empty(offenders);
    }

    private static async Task<(AgentRunResult RunResult, RecordingSink Sink)> RunWithFixture(AgentRunnerKind kind, string fixtureFile)
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = InstallAll();
        var runner = AgentTestHarness.MakeRunner(kind, spawner, clock, locator);
        var sink = new RecordingSink();

        var lines = File.ReadAllLines(FixturePath(kind, fixtureFile));

        spawner.OnSpawn = h =>
        {
            _ = Task.Run(async () =>
            {
                foreach (var line in lines)
                {
                    await h.WriteStdoutLineAsync(line);
                }

                h.Complete(0);
            });
        };

        var result = await runner.RunAsync(
            AgentTestHarness.MakeSpec(kind),
            AgentTestHarness.SampleCtx(),
            sink,
            CancellationToken.None);

        return (result, sink);
    }

    private static string FixturePath(AgentRunnerKind kind, string file)
        => Path.Combine(AgentTestHarness.FixturesDir(), kind.ToString(), file);

    private static FakeExecutableLocator InstallAll()
    {
        var locator = new FakeExecutableLocator();
        foreach (var name in new[] { "claude", "codex", "gemini", "copilot", "gh", "qwen" })
        {
            _ = locator.Installed.Add(name);
        }

        return locator;
    }

    private static string LocateAgentSourceDir()
    {
        // Walk up from the test binary until we find dotnet/src/execution/AiOrchestrator.Agent.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "dotnet", "src", "execution", "AiOrchestrator.Agent");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate dotnet/src/execution/AiOrchestrator.Agent above " + AppContext.BaseDirectory);
    }
}
