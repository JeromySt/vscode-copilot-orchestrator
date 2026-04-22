// <copyright file="ProcessSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Models;

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
