// <copyright file="ShellSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Models;

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
