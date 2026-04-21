// <copyright file="ClaudeCodeRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Agent.Runners;

/// <summary>Claude Code CLI runner (<c>claude</c>). Supports <see cref="Effort.Xhigh"/> (INV-8).</summary>
internal sealed class ClaudeCodeRunner : AgentRunnerBase
{
    /// <summary>Initializes a new instance of the <see cref="ClaudeCodeRunner"/> class.</summary>
    /// <param name="spawner">Process spawner.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="locator">Executable locator.</param>
    /// <param name="logger">Logger.</param>
    public ClaudeCodeRunner(IProcessSpawner spawner, IClock clock, IExecutableLocator locator, ILogger<ClaudeCodeRunner> logger)
        : base(spawner, clock, locator, logger)
    {
    }

    /// <inheritdoc/>
    public override AgentRunnerKind Kind => AgentRunnerKind.ClaudeCode;

    /// <inheritdoc/>
    protected override string ExecutableName => "claude";

    /// <inheritdoc/>
    protected override bool SupportsXhighEffort => true;

    /// <inheritdoc/>
    protected override ImmutableArray<string> BuildArgs(AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var b = ImmutableArray.CreateBuilder<string>();
        b.Add("--print");
        b.Add(spec.Instructions);
        b.Add("--max-turns");
        b.Add(spec.MaxTurns.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (spec.Model is not null)
        {
            b.Add("--model");
            b.Add(spec.Model);
        }

        b.Add("--reasoning-effort");
        b.Add(spec.Effort.ToString().ToLowerInvariant());
        foreach (var f in spec.AllowedFolders)
        {
            b.Add("--allowed-tools");
            b.Add($"Read({f.Value}),Edit({f.Value}),Write({f.Value})");
        }

        foreach (var u in spec.AllowedUrls)
        {
            b.Add("--allowed-tools");
            b.Add($"WebFetch({u})");
        }

        if (spec is { ResumeSession: true, ResumeSessionId: { } sid })
        {
            b.Add("--resume");
            b.Add(sid);
        }

        return b.ToImmutable();
    }
}
