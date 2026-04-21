// <copyright file="DiffRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a diff operation.</summary>
public sealed record DiffRequest
{
    /// <summary>Gets the older tree SHA.</summary>
    public required CommitSha From { get; init; }

    /// <summary>Gets the newer tree SHA.</summary>
    public required CommitSha To { get; init; }
}
