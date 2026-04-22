// <copyright file="WorkSpec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace AiOrchestrator.Plan.Models;

/// <summary>Describes the work a job agent should perform and the constraints it operates under.</summary>
public sealed record WorkSpec
{
    /// <summary>Gets the folders the agent is allowed to read and write.</summary>
    public IReadOnlyList<string> AllowedFolders { get; init; } = [];

    /// <summary>Gets the URLs the agent is allowed to access.</summary>
    public IReadOnlyList<string> AllowedUrls { get; init; } = [];

    /// <summary>Gets the shell commands run after the agent completes to verify correctness.</summary>
    public IReadOnlyList<string> CheckCommands { get; init; } = [];

    /// <summary>Gets the natural-language instructions provided to the agent.</summary>
    public string? Instructions { get; init; }
}
