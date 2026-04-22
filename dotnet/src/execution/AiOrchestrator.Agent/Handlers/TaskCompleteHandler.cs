// <copyright file="TaskCompleteHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.RegularExpressions;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Agent.Handlers;

/// <summary>Detects the runner-specific "done" marker (INV-6). Flips <see cref="Completed"/> at most once.</summary>
internal sealed partial class TaskCompleteHandler : HandlerBase
{
    /// <summary>Initializes a new instance of the <see cref="TaskCompleteHandler"/> class.</summary>
    /// <param name="clock">Clock.</param>
    public TaskCompleteHandler(IClock clock)
        : base(clock)
    {
    }

    /// <summary>Gets a value indicating whether the handler observed the done marker.</summary>
    public bool Completed { get; private set; }

    /// <summary>Gets the last line observed when the done marker fired, for forwarding as final response.</summary>
    public string FinalResponse { get; private set; } = string.Empty;

    /// <inheritdoc/>
    public override bool TryHandle(LineEmitted line, AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(line);
        ArgumentNullException.ThrowIfNull(spec);

        if (this.Completed)
        {
            return false;
        }

        var regex = RegexFor(spec.Runner);
        if (regex.IsMatch(line.Line))
        {
            this.Completed = true;
            this.FinalResponse = line.Line;
            return true;
        }

        return false;
    }

    [GeneratedRegex("\\[claude\\]\\s*task\\s+complete|<claude-done/>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ClaudeDoneRegex();

    [GeneratedRegex("\"type\"\\s*:\\s*\"task_complete\"", RegexOptions.CultureInvariant)]
    private static partial Regex CodexDoneRegex();

    [GeneratedRegex("\\[gemini\\]\\s*done|gemini-task-complete", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GeminiDoneRegex();

    [GeneratedRegex("copilot:\\s*task\\s+complete", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CopilotDoneRegex();

    [GeneratedRegex("gh\\s*copilot:\\s*task\\s+complete", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GhCopilotDoneRegex();

    [GeneratedRegex("qwen:\\s*task\\s+complete", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex QwenDoneRegex();

    private static Regex RegexFor(AgentRunnerKind kind) => kind switch
    {
        AgentRunnerKind.ClaudeCode => ClaudeDoneRegex(),
        AgentRunnerKind.CodexCli => CodexDoneRegex(),
        AgentRunnerKind.GeminiCli => GeminiDoneRegex(),
        AgentRunnerKind.CopilotCli => CopilotDoneRegex(),
        AgentRunnerKind.GhCopilot => GhCopilotDoneRegex(),
        AgentRunnerKind.Qwen => QwenDoneRegex(),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unsupported runner kind."),
    };
}
