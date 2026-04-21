// <copyright file="AgentRunnerKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Identifies a concrete AI agent CLI runner implementation.</summary>
public enum AgentRunnerKind
{
    /// <summary>Claude Code CLI (<c>claude</c>).</summary>
    ClaudeCode,

    /// <summary>OpenAI Codex CLI (<c>codex</c>).</summary>
    CodexCli,

    /// <summary>Google Gemini CLI (<c>gemini</c>).</summary>
    GeminiCli,

    /// <summary>Microsoft Copilot native CLI (<c>copilot</c>). Distinct from <see cref="GhCopilot"/>.</summary>
    CopilotCli,

    /// <summary>GitHub Copilot CLI plugin invoked via <c>gh copilot</c>. Distinct from <see cref="CopilotCli"/>.</summary>
    GhCopilot,

    /// <summary>Qwen CLI (<c>qwen</c>).</summary>
    Qwen,
}
