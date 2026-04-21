// <copyright file="AgentSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Agent;

/// <summary>Describes a single agent invocation.</summary>
public sealed record AgentSpec
{
    /// <summary>Gets the runner kind to execute this spec (INV-11: resolved by <see cref="AgentRunnerFactory"/>).</summary>
    public required AgentRunnerKind Runner { get; init; }

    /// <summary>Gets the in-line instruction payload.</summary>
    public required string Instructions { get; init; }

    /// <summary>Gets an optional absolute path to an instructions file, used when the payload is large.</summary>
    public AbsolutePath? InstructionsFile { get; init; }

    /// <summary>Gets the list of context files to surface to the agent.</summary>
    public ImmutableArray<string> ContextFiles { get; init; } = ImmutableArray<string>.Empty;

    /// <summary>Gets the folders the agent is permitted to read/write (INV-3, INV-10).</summary>
    public ImmutableArray<AbsolutePath> AllowedFolders { get; init; } = ImmutableArray<AbsolutePath>.Empty;

    /// <summary>Gets the URLs the agent is permitted to fetch (INV-3).</summary>
    public ImmutableArray<string> AllowedUrls { get; init; } = ImmutableArray<string>.Empty;

    /// <summary>Gets an explicit model identifier, if overriding <see cref="ModelTier"/>.</summary>
    public string? Model { get; init; }

    /// <summary>Gets the semantic model tier.</summary>
    public ModelTier? ModelTier { get; init; }

    /// <summary>Gets the reasoning effort knob (INV-8).</summary>
    public Effort Effort { get; init; } = Effort.Medium;

    /// <summary>Gets the maximum number of agent turns (INV-9).</summary>
    public int MaxTurns { get; init; } = 30;

    /// <summary>Gets a value indicating whether to resume a prior session (INV-4).</summary>
    public bool ResumeSession { get; init; }

    /// <summary>Gets the session id to resume when <see cref="ResumeSession"/> is true.</summary>
    public string? ResumeSessionId { get; init; }

    /// <summary>Gets the environment variables to set for the agent process.</summary>
    public ImmutableDictionary<string, string> Env { get; init; } = ImmutableDictionary<string, string>.Empty;

    /// <summary>Gets the absolute working directory in which to invoke the agent.</summary>
    public AbsolutePath? WorkingDirectory { get; init; }
}
