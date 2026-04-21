// <copyright file="AgentSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models;

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
