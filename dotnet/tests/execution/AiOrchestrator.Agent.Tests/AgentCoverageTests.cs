// <copyright file="AgentCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Agent.Handlers;
using AiOrchestrator.Agent.Tests.Fakes;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Agent.Tests;

/// <summary>Coverage tests for Agent types: specs, results, enums, handlers, factory, and exceptions.</summary>
public sealed class AgentCoverageTests
{
    // ---- ContextPressureLevel enum -----------------------------------------

    [Theory]
    [InlineData(ContextPressureLevel.None, 0)]
    [InlineData(ContextPressureLevel.Rising, 1)]
    [InlineData(ContextPressureLevel.High, 2)]
    [InlineData(ContextPressureLevel.Critical, 3)]
    public void ContextPressureLevel_HasExpectedValues(ContextPressureLevel level, int expected)
    {
        Assert.Equal(expected, (int)level);
    }

    // ---- Effort enum -------------------------------------------------------

    [Theory]
    [InlineData(Effort.Low, 0)]
    [InlineData(Effort.Medium, 1)]
    [InlineData(Effort.High, 2)]
    [InlineData(Effort.Xhigh, 3)]
    public void Effort_HasExpectedValues(Effort effort, int expected)
    {
        Assert.Equal(expected, (int)effort);
    }

    // ---- ModelTier enum ----------------------------------------------------

    [Theory]
    [InlineData(ModelTier.Fast, 0)]
    [InlineData(ModelTier.Standard, 1)]
    [InlineData(ModelTier.Premium, 2)]
    public void ModelTier_HasExpectedValues(ModelTier tier, int expected)
    {
        Assert.Equal(expected, (int)tier);
    }

    // ---- AgentRunnerKind enum ----------------------------------------------

    [Theory]
    [InlineData(AgentRunnerKind.ClaudeCode, 0)]
    [InlineData(AgentRunnerKind.CodexCli, 1)]
    [InlineData(AgentRunnerKind.GeminiCli, 2)]
    [InlineData(AgentRunnerKind.CopilotCli, 3)]
    [InlineData(AgentRunnerKind.GhCopilot, 4)]
    [InlineData(AgentRunnerKind.Qwen, 5)]
    public void AgentRunnerKind_HasExpectedValues(AgentRunnerKind kind, int expected)
    {
        Assert.Equal(expected, (int)kind);
    }

    [Fact]
    public void AgentRunnerKind_AllValuesAreDefined()
    {
        var values = Enum.GetValues<AgentRunnerKind>();
        Assert.Equal(6, values.Length);
    }

    // ---- AgentStream enum --------------------------------------------------

    [Theory]
    [InlineData(AgentStream.Stdout, 0)]
    [InlineData(AgentStream.Stderr, 1)]
    public void AgentStream_HasExpectedValues(AgentStream stream, int expected)
    {
        Assert.Equal(expected, (int)stream);
    }

    // ---- AgentSpec construction --------------------------------------------

    [Fact]
    public void AgentSpec_DefaultEffort_IsMedium()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.ClaudeCode,
            Instructions = "do something",
        };
        Assert.Equal(Effort.Medium, spec.Effort);
    }

    [Fact]
    public void AgentSpec_DefaultMaxTurns_Is30()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.ClaudeCode,
            Instructions = "test",
        };
        Assert.Equal(30, spec.MaxTurns);
    }

    [Fact]
    public void AgentSpec_DefaultResumeSession_IsFalse()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.ClaudeCode,
            Instructions = "test",
        };
        Assert.False(spec.ResumeSession);
    }

    [Fact]
    public void AgentSpec_DefaultCollections_AreEmpty()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.ClaudeCode,
            Instructions = "test",
        };
        Assert.Empty(spec.ContextFiles);
        Assert.Empty(spec.AllowedFolders);
        Assert.Empty(spec.AllowedUrls);
        Assert.Empty(spec.Env);
    }

    [Fact]
    public void AgentSpec_OptionalProperties_AreNull()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.ClaudeCode,
            Instructions = "test",
        };
        Assert.Null(spec.Model);
        Assert.Null(spec.ModelTier);
        Assert.Null(spec.ResumeSessionId);
        Assert.Null(spec.InstructionsFile);
        Assert.Null(spec.WorkingDirectory);
    }

    [Fact]
    public void AgentSpec_AllPropertiesCanBeSet()
    {
        var spec = new AgentSpec
        {
            Runner = AgentRunnerKind.CopilotCli,
            Instructions = "implement feature",
            InstructionsFile = new AbsolutePath("/tmp/instructions.md"),
            ContextFiles = ImmutableArray.Create("file1.ts"),
            AllowedFolders = ImmutableArray.Create(new AbsolutePath("/src")),
            AllowedUrls = ImmutableArray.Create("https://example.com"),
            Model = "claude-sonnet-4.5",
            ModelTier = ModelTier.Premium,
            Effort = Effort.High,
            MaxTurns = 50,
            ResumeSession = true,
            ResumeSessionId = "sess-123",
            Env = ImmutableDictionary.CreateRange(new[] { new KeyValuePair<string, string>("KEY", "val") }),
            WorkingDirectory = new AbsolutePath("/workspace"),
        };

        Assert.Equal(AgentRunnerKind.CopilotCli, spec.Runner);
        Assert.Equal("implement feature", spec.Instructions);
        Assert.NotNull(spec.InstructionsFile);
        Assert.Single(spec.ContextFiles);
        Assert.Single(spec.AllowedFolders);
        Assert.Single(spec.AllowedUrls);
        Assert.Equal("claude-sonnet-4.5", spec.Model);
        Assert.Equal(ModelTier.Premium, spec.ModelTier);
        Assert.Equal(Effort.High, spec.Effort);
        Assert.Equal(50, spec.MaxTurns);
        Assert.True(spec.ResumeSession);
        Assert.Equal("sess-123", spec.ResumeSessionId);
        Assert.Single(spec.Env);
        Assert.Equal("/workspace", spec.WorkingDirectory!.Value.Value);
    }

    // ---- AgentStats --------------------------------------------------------

    [Fact]
    public void AgentStats_Empty_ReturnsZeroedRecord()
    {
        var stats = AgentStats.Empty();
        Assert.Equal(0, stats.InputTokens);
        Assert.Equal(0, stats.OutputTokens);
        Assert.Equal(0, stats.Turns);
        Assert.Null(stats.EstimatedCostUsd);
        Assert.Empty(stats.ProviderRaw);
    }

    [Fact]
    public void AgentStats_CanConstruct()
    {
        var raw = ImmutableDictionary.CreateRange(new[]
        {
            new KeyValuePair<string, long>("cache_tokens", 500),
        });

        var stats = new AgentStats
        {
            InputTokens = 1000,
            OutputTokens = 200,
            Turns = 5,
            EstimatedCostUsd = 0.05m,
            ProviderRaw = raw,
        };

        Assert.Equal(1000, stats.InputTokens);
        Assert.Equal(200, stats.OutputTokens);
        Assert.Equal(5, stats.Turns);
        Assert.Equal(0.05m, stats.EstimatedCostUsd);
        Assert.Single(stats.ProviderRaw);
    }

    // ---- AgentRunResult ----------------------------------------------------

    [Fact]
    public void AgentRunResult_CanConstruct()
    {
        var result = new AgentRunResult
        {
            ExitCode = 0,
            SessionId = "sess-1",
            Stats = AgentStats.Empty(),
            Duration = TimeSpan.FromSeconds(10),
            TaskCompleteEmitted = true,
            ChangedFiles = ImmutableArray<RepoRelativePath>.Empty,
        };

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("sess-1", result.SessionId);
        Assert.NotNull(result.Stats);
        Assert.True(result.TaskCompleteEmitted);
        Assert.Empty(result.ChangedFiles);
        Assert.False(result.MaxTurnsExceeded);
        Assert.False(result.SandboxUnsupportedWarning);
    }

    [Fact]
    public void AgentRunResult_OptionalFlags()
    {
        var result = new AgentRunResult
        {
            ExitCode = 1,
            SessionId = null,
            Stats = AgentStats.Empty(),
            Duration = TimeSpan.FromMinutes(5),
            TaskCompleteEmitted = false,
            ChangedFiles = ImmutableArray<RepoRelativePath>.Empty,
            MaxTurnsExceeded = true,
            SandboxUnsupportedWarning = true,
        };

        Assert.Null(result.SessionId);
        Assert.True(result.MaxTurnsExceeded);
        Assert.True(result.SandboxUnsupportedWarning);
    }

    // ---- LineEmitted -------------------------------------------------------

    [Fact]
    public void LineEmitted_CanConstruct()
    {
        var line = new LineEmitted
        {
            Stream = AgentStream.Stdout,
            Line = "hello from agent",
            MonotonicMs = 42,
        };

        Assert.Equal(AgentStream.Stdout, line.Stream);
        Assert.Equal("hello from agent", line.Line);
        Assert.Equal(42, line.MonotonicMs);
    }

    [Fact]
    public void LineEmitted_DefaultMonotonicMs_IsZero()
    {
        var line = new LineEmitted
        {
            Stream = AgentStream.Stderr,
            Line = "error",
        };
        Assert.Equal(0, line.MonotonicMs);
    }

    // ---- RunContext ---------------------------------------------------------

    [Fact]
    public void RunContext_CanConstruct()
    {
        var ctx = new RunContext
        {
            JobId = new JobId(Guid.NewGuid()),
            RunId = new RunId(Guid.NewGuid()),
            Principal = new AuthContext
            {
                PrincipalId = "tester",
                DisplayName = "Tester",
                Scopes = ImmutableArray.Create("plan.run"),
            },
        };

        Assert.NotNull(ctx.JobId);
        Assert.NotNull(ctx.RunId);
        Assert.Equal("tester", ctx.Principal.PrincipalId);
    }

    // ---- AgentRunnerNotInstalledException ----------------------------------

    [Fact]
    public void AgentRunnerNotInstalledException_KindAndPath()
    {
        var ex = new AgentRunnerNotInstalledException(AgentRunnerKind.ClaudeCode, "claude");
        Assert.Contains("claude", ex.Message);
        Assert.Equal(AgentRunnerKind.ClaudeCode, ex.Kind);
        Assert.Equal("claude", ex.ProbedPath);
    }

    [Fact]
    public void AgentRunnerNotInstalledException_DefaultCtor()
    {
        var ex = new AgentRunnerNotInstalledException();
        Assert.NotNull(ex.Message);
        Assert.Equal(string.Empty, ex.ProbedPath);
    }

    [Fact]
    public void AgentRunnerNotInstalledException_MessageCtor()
    {
        var ex = new AgentRunnerNotInstalledException("custom msg");
        Assert.Equal("custom msg", ex.Message);
    }

    [Fact]
    public void AgentRunnerNotInstalledException_InnerExceptionCtor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new AgentRunnerNotInstalledException("outer", inner);
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    // ---- AgentRunnerFactory ------------------------------------------------

    [Fact]
    public void AgentRunnerFactory_NullRunners_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new AgentRunnerFactory(null!));
    }

    [Fact]
    public void AgentRunnerFactory_EmptyRunners_CreatesFactory()
    {
        var factory = new AgentRunnerFactory([]);
        Assert.Throws<AgentRunnerNotInstalledException>(() => factory.Resolve(AgentRunnerKind.ClaudeCode));
    }

    [Fact]
    public void AgentRunnerFactory_NullEntryInCollection_Throws()
    {
        Assert.Throws<ArgumentException>(() => new AgentRunnerFactory([null!]));
    }

    [Fact]
    public void AgentRunnerFactory_DuplicateKind_Throws()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = new FakeExecutableLocator();
        _ = locator.Installed.Add("copilot");

        var runner1 = AgentTestHarness.MakeRunner(AgentRunnerKind.CopilotCli, spawner, clock, locator);
        var runner2 = AgentTestHarness.MakeRunner(AgentRunnerKind.CopilotCli, spawner, clock, locator);

        Assert.Throws<InvalidOperationException>(() => new AgentRunnerFactory([runner1, runner2]));
    }

    [Fact]
    public void AgentRunnerFactory_Resolve_ReturnsCorrectRunner()
    {
        var spawner = new FakeProcessSpawner();
        var clock = new FakeClock();
        var locator = new FakeExecutableLocator();
        _ = locator.Installed.Add("copilot");
        _ = locator.Installed.Add("claude");

        var copilotRunner = AgentTestHarness.MakeRunner(AgentRunnerKind.CopilotCli, spawner, clock, locator);
        var claudeRunner = AgentTestHarness.MakeRunner(AgentRunnerKind.ClaudeCode, spawner, clock, locator);
        var factory = new AgentRunnerFactory([copilotRunner, claudeRunner]);

        Assert.Same(copilotRunner, factory.Resolve(AgentRunnerKind.CopilotCli));
        Assert.Same(claudeRunner, factory.Resolve(AgentRunnerKind.ClaudeCode));
    }

    [Fact]
    public void AgentRunnerFactory_Resolve_UnknownKind_Throws()
    {
        var factory = new AgentRunnerFactory([]);
        var ex = Assert.Throws<AgentRunnerNotInstalledException>(() => factory.Resolve(AgentRunnerKind.Qwen));
        Assert.Equal(AgentRunnerKind.Qwen, ex.Kind);
    }

    // ---- ContextPressureHandler thresholds ----------------------------------

    [Fact]
    public void ContextPressureHandler_Thresholds_AreCorrect()
    {
        Assert.Equal(0.60, ContextPressureHandler.RisingThreshold);
        Assert.Equal(0.80, ContextPressureHandler.HighThreshold);
        Assert.Equal(0.92, ContextPressureHandler.CriticalThreshold);
    }

    [Fact]
    public void ContextPressureHandler_InitialLevel_IsNone()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        Assert.Equal(ContextPressureLevel.None, handler.Level);
        Assert.Equal(0, handler.Fraction);
        Assert.False(handler.PendingTransition);
    }

    [Fact]
    public void ContextPressureHandler_RisingLine_SetsRisingLevel()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        var line = MakeLine("context_usage=65%");
        bool handled = handler.TryHandle(line, spec);

        Assert.True(handled);
        Assert.Equal(ContextPressureLevel.Rising, handler.Level);
        Assert.True(handler.PendingTransition);
    }

    [Fact]
    public void ContextPressureHandler_HighLine_SetsHighLevel()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        handler.TryHandle(MakeLine("context_usage=85%"), spec);
        Assert.Equal(ContextPressureLevel.High, handler.Level);
    }

    [Fact]
    public void ContextPressureHandler_CriticalLine_SetsCriticalLevel()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        handler.TryHandle(MakeLine("context_usage=95%"), spec);
        Assert.Equal(ContextPressureLevel.Critical, handler.Level);
    }

    [Fact]
    public void ContextPressureHandler_LevelDoesNotDecrease()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        handler.TryHandle(MakeLine("context_usage=85%"), spec);
        Assert.Equal(ContextPressureLevel.High, handler.Level);

        // Dropping to 50% should NOT decrease back to None
        handler.TryHandle(MakeLine("context_usage=50%"), spec);
        Assert.Equal(ContextPressureLevel.High, handler.Level);
    }

    [Fact]
    public void ContextPressureHandler_UnrecognizedLine_ReturnsFalse()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        bool handled = handler.TryHandle(MakeLine("unrelated output line"), spec);
        Assert.False(handled);
        Assert.Equal(ContextPressureLevel.None, handler.Level);
    }

    [Fact]
    public void ContextPressureHandler_ClearPending_ClearsFlag()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        handler.TryHandle(MakeLine("context_usage=65%"), spec);
        Assert.True(handler.PendingTransition);

        handler.ClearPending();
        Assert.False(handler.PendingTransition);
    }

    [Fact]
    public void ContextPressureHandler_FractionFormat_AcceptsBothPercentAndDecimal()
    {
        var clock = new FakeClock();
        var handler = new ContextPressureHandler(clock);
        var spec = AgentTestHarness.MakeSpec(AgentRunnerKind.ClaudeCode);

        // Percentage format: 65%
        handler.TryHandle(MakeLine("context_usage=65%"), spec);
        Assert.True(handler.Fraction > 0.6 && handler.Fraction < 0.7);
    }

    // ---- FakeExecutableLocator (DefaultExecutableLocator pattern) -----------

    [Fact]
    public void FakeExecutableLocator_InstalledName_ReturnsPath()
    {
        var locator = new FakeExecutableLocator();
        _ = locator.Installed.Add("claude");
        Assert.NotNull(locator.Locate("claude"));
    }

    [Fact]
    public void FakeExecutableLocator_UninstalledName_ReturnsNull()
    {
        var locator = new FakeExecutableLocator();
        Assert.Null(locator.Locate("nonexistent"));
    }

    // ---- Helpers ------------------------------------------------------------

    private static LineEmitted MakeLine(string text) => new()
    {
        Stream = AgentStream.Stdout,
        Line = text,
    };
}
