// <copyright file="WorkSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text.Json.Serialization;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Models;

/// <summary>Discriminated union base for all work specifications.</summary>
[JsonDerivedType(typeof(AgentSpec), typeDiscriminator: "agent")]
[JsonDerivedType(typeof(ShellSpec), typeDiscriminator: "shell")]
[JsonDerivedType(typeof(ProcessSpec), typeDiscriminator: "process")]
public abstract record WorkSpec
{
    /// <summary>Gets the identifier of the producer or agent that owns this spec.</summary>
    public required string Producer { get; init; }

    /// <summary>Gets a human-readable description of what this spec accomplishes.</summary>
    public required string Description { get; init; }
}

/// <summary>Specifies work to be performed by an AI coding agent.</summary>
public sealed record AgentSpec : WorkSpec
{
    /// <summary>Gets the kind of AI agent to invoke.</summary>
    public required AgentKind Kind { get; init; }

    /// <summary>Gets the prompt or instruction to pass to the agent.</summary>
    public required string Prompt { get; init; }

    /// <summary>Gets the model identifier to use, if overriding the default.</summary>
    public string? Model { get; init; }

    /// <summary>Gets the maximum time to allow the agent to run, if bounded.</summary>
    public TimeSpan? Timeout { get; init; }
}

/// <summary>Specifies work to be performed by a shell script.</summary>
public sealed record ShellSpec : WorkSpec
{
    /// <summary>Gets the shell interpreter to use.</summary>
    public required ShellKind Shell { get; init; }

    /// <summary>Gets the shell script content to execute.</summary>
    public required string Script { get; init; }

    /// <summary>Gets the repository-relative directory in which to run the script, if not the repo root.</summary>
    public RepoRelativePath? WorkingDirectory { get; init; }
}

/// <summary>Specifies work to be performed by spawning an external process.</summary>
public sealed record ProcessSpec : WorkSpec
{
    /// <summary>Gets the path or name of the executable to spawn.</summary>
    public required string Executable { get; init; }

    /// <summary>Gets the command-line arguments to pass to the executable.</summary>
    public required ImmutableArray<string> Arguments { get; init; }

    /// <summary>Gets the environment variables to set for the spawned process, if any.</summary>
    public ImmutableDictionary<string, string>? Environment { get; init; }
}

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

/// <summary>The supported shell interpreter types.</summary>
public enum ShellKind
{
    /// <summary>GNU Bash shell.</summary>
    Bash,

    /// <summary>POSIX sh shell.</summary>
    Sh,

    /// <summary>Windows Command Prompt.</summary>
    Cmd,

    /// <summary>Windows PowerShell (powershell.exe).</summary>
    PowerShell,

    /// <summary>PowerShell Core (pwsh).</summary>
    Pwsh,
}
