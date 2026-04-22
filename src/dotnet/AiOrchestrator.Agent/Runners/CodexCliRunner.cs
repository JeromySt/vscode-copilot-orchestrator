// <copyright file="CodexCliRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Agent.Runners;

/// <summary>OpenAI Codex CLI runner (<c>codex</c>).</summary>
internal sealed class CodexCliRunner : AgentRunnerBase
{
    /// <summary>Initializes a new instance of the <see cref="CodexCliRunner"/> class.</summary>
    /// <param name="spawner">Process spawner.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="locator">Executable locator.</param>
    /// <param name="logger">Logger.</param>
    public CodexCliRunner(IProcessSpawner spawner, IClock clock, IExecutableLocator locator, ILogger<CodexCliRunner> logger)
        : base(spawner, clock, locator, logger)
    {
    }

    /// <inheritdoc/>
    public override AgentRunnerKind Kind => AgentRunnerKind.CodexCli;

    /// <inheritdoc/>
    protected override string ExecutableName => "codex";

    /// <inheritdoc/>
    protected override ImmutableArray<string> BuildArgs(AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        var b = ImmutableArray.CreateBuilder<string>();
        b.Add("exec");
        b.Add(spec.Instructions);
        b.Add("--max-turns");
        b.Add(spec.MaxTurns.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (spec.Model is not null)
        {
            b.Add("--model");
            b.Add(spec.Model);
        }

        foreach (var f in spec.AllowedFolders)
        {
            b.Add("--sandbox-writable-path");
            b.Add(f.Value);
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
