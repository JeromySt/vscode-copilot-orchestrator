// <copyright file="WalkRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a commit walk (history traversal).</summary>
public sealed record WalkRequest
{
    /// <summary>Gets the starting commit SHA.</summary>
    public required CommitSha From { get; init; }

    /// <summary>Gets the optional stopping commit SHA (exclusive).</summary>
    public CommitSha? Until { get; init; }

    /// <summary>Gets the maximum number of commits to yield.</summary>
    public int? Limit { get; init; }
}
