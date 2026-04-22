// <copyright file="GhCopilotRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Agent.Runners;

/// <summary>GitHub Copilot CLI plugin runner invoked via <c>gh copilot</c>. Distinct from <see cref="CopilotCliRunner"/> (INV-2).</summary>
internal sealed class GhCopilotRunner : AgentRunnerBase
{
    /// <summary>Initializes a new instance of the <see cref="GhCopilotRunner"/> class.</summary>
    /// <param name="spawner">Process spawner.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="locator">Executable locator.</param>
    /// <param name="logger">Logger.</param>
    public GhCopilotRunner(IProcessSpawner spawner, IClock clock, IExecutableLocator locator, ILogger<GhCopilotRunner> logger)
        : base(spawner, clock, locator, logger)
    {
    }

    /// <inheritdoc/>
    public override AgentRunnerKind Kind => AgentRunnerKind.GhCopilot;

    /// <inheritdoc/>
    protected override string ExecutableName => "gh";

    /// <inheritdoc/>
    protected override bool SupportsSandbox => false;

    /// <inheritdoc/>
    protected override ImmutableArray<string> BuildArgs(AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var b = ImmutableArray.CreateBuilder<string>();
        b.Add("copilot");
        b.Add("--prompt");
        b.Add(spec.Instructions);
        b.Add("--max-turns");
        b.Add(spec.MaxTurns.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (spec.Model is not null)
        {
            b.Add("--model");
            b.Add(spec.Model);
        }

        foreach (var u in spec.AllowedUrls)
        {
            b.Add("--allow-url");
            b.Add(u);
        }

        if (spec is { ResumeSession: true, ResumeSessionId: { } sid })
        {
            b.Add("--resume");
            b.Add(sid);
        }

        return b.ToImmutable();
    }
}
