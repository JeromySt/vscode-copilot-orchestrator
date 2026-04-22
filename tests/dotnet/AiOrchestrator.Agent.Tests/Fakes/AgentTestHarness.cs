// <copyright file="AgentTestHarness.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Agent.Runners;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging.Abstractions;

namespace AiOrchestrator.Agent.Tests.Fakes;

/// <summary>Constructs runners wired to deterministic fakes.</summary>
internal static class AgentTestHarness
{
    /// <summary>Builds a run context suitable for unit tests.</summary>
    /// <returns>A <see cref="RunContext"/>.</returns>
    public static RunContext SampleCtx() => new()
    {
        JobId = new JobId(Guid.Parse("11111111-1111-1111-1111-111111111111")),
        RunId = new RunId(Guid.Parse("22222222-2222-2222-2222-222222222222")),
        Principal = new AuthContext
        {
            PrincipalId = "tester",
            DisplayName = "Tester",
            Scopes = System.Collections.Immutable.ImmutableArray.Create("plan.run"),
        },
    };

    /// <summary>Gets the repo-root-relative fixtures directory.</summary>
    /// <returns>Path.</returns>
    public static string FixturesDir() => Path.Combine(AppContext.BaseDirectory, "Fixtures");

    /// <summary>Builds a runner by kind, wired to the supplied fakes.</summary>
    /// <param name="kind">Runner kind.</param>
    /// <param name="spawner">Fake spawner.</param>
    /// <param name="clock">Fake clock.</param>
    /// <param name="locator">Fake locator.</param>
    /// <returns>The runner.</returns>
    public static IAgentRunner MakeRunner(AgentRunnerKind kind, FakeProcessSpawner spawner, FakeClock clock, IExecutableLocator locator)
    {
        return kind switch
        {
            AgentRunnerKind.ClaudeCode => new ClaudeCodeRunner(spawner, clock, locator, NullLogger<ClaudeCodeRunner>.Instance),
            AgentRunnerKind.CodexCli => new CodexCliRunner(spawner, clock, locator, NullLogger<CodexCliRunner>.Instance),
            AgentRunnerKind.GeminiCli => new GeminiCliRunner(spawner, clock, locator, NullLogger<GeminiCliRunner>.Instance),
            AgentRunnerKind.CopilotCli => new CopilotCliRunner(spawner, clock, locator, NullLogger<CopilotCliRunner>.Instance),
            AgentRunnerKind.GhCopilot => new GhCopilotRunner(spawner, clock, locator, NullLogger<GhCopilotRunner>.Instance),
            AgentRunnerKind.Qwen => new QwenRunner(spawner, clock, locator, NullLogger<QwenRunner>.Instance),
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
        };
    }

    /// <summary>Builds an <see cref="AgentSpec"/> with sensible defaults.</summary>
    /// <param name="kind">Runner kind.</param>
    /// <returns>The spec.</returns>
    public static AgentSpec MakeSpec(AgentRunnerKind kind) => new()
    {
        Runner = kind,
        Instructions = "do the thing",
        MaxTurns = 30,
    };
}
