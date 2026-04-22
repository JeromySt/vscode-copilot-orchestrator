// <copyright file="WorkSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;

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
