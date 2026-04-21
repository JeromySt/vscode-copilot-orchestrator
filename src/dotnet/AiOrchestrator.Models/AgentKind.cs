// <copyright file="AgentKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models;

/// <summary>The supported AI coding agent runtimes.</summary>
public enum AgentKind
{
    /// <summary>Claude Code agent.</summary>
    ClaudeCode,

    /// <summary>Codex CLI agent.</summary>
    CodexCli,

    /// <summary>Gemini CLI agent.</summary>
    GeminiCli,

    /// <summary>GitHub Copilot CLI agent.</summary>
    CopilotCli,

    /// <summary>GitHub Copilot agent.</summary>
    GhCopilot,

    /// <summary>Qwen agent.</summary>
    Qwen,
}
