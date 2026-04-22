// <copyright file="SessionIdHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.RegularExpressions;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Agent.Handlers;

/// <summary>
/// Parses the session id emitted by a runner's output. Uses <see cref="GeneratedRegexAttribute"/>
/// patterns per runner kind (INV-4). Populates <see cref="SessionId"/> at most once.
/// </summary>
internal sealed partial class SessionIdHandler : HandlerBase
{
    /// <summary>Initializes a new instance of the <see cref="SessionIdHandler"/> class.</summary>
    /// <param name="clock">Clock.</param>
    public SessionIdHandler(IClock clock)
        : base(clock)
    {
    }

    /// <summary>Gets the parsed session id, if observed.</summary>
    public string? SessionId { get; private set; }

    /// <inheritdoc/>
    public override bool TryHandle(LineEmitted line, AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(line);
        ArgumentNullException.ThrowIfNull(spec);

        if (this.SessionId is not null)
        {
            return false;
        }

        var regex = RegexFor(spec.Runner);
        var match = regex.Match(line.Line);
        if (match.Success && match.Groups.Count > 1)
        {
            this.SessionId = match.Groups[1].Value;
            return true;
        }

        return false;
    }

    [GeneratedRegex("session[_ ]id[=:]\\s*([A-Za-z0-9_\\-]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ClaudeSessionRegex();

    [GeneratedRegex("\"session_id\"\\s*:\\s*\"([A-Za-z0-9_\\-]+)\"", RegexOptions.CultureInvariant)]
    private static partial Regex CodexSessionRegex();

    [GeneratedRegex("gemini\\s+session[:=]\\s*([A-Za-z0-9_\\-]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GeminiSessionRegex();

    [GeneratedRegex("copilot-session[=:]\\s*([A-Za-z0-9_\\-]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CopilotSessionRegex();

    [GeneratedRegex("gh-copilot-session[=:]\\s*([A-Za-z0-9_\\-]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GhCopilotSessionRegex();

    [GeneratedRegex("qwen-session[=:]\\s*([A-Za-z0-9_\\-]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex QwenSessionRegex();

    private static Regex RegexFor(AgentRunnerKind kind) => kind switch
    {
        AgentRunnerKind.ClaudeCode => ClaudeSessionRegex(),
        AgentRunnerKind.CodexCli => CodexSessionRegex(),
        AgentRunnerKind.GeminiCli => GeminiSessionRegex(),
        AgentRunnerKind.CopilotCli => CopilotSessionRegex(),
        AgentRunnerKind.GhCopilot => GhCopilotSessionRegex(),
        AgentRunnerKind.Qwen => QwenSessionRegex(),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported runner kind."),
    };
}
