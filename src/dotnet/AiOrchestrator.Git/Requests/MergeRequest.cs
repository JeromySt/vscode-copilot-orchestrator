// <copyright file="MergeRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a merge operation.</summary>
public sealed record MergeRequest
{
    /// <summary>Gets the SHA of the commit to merge into HEAD.</summary>
    public required CommitSha Source { get; init; }

    /// <summary>Gets the principal whose identity is used as the merger.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the merge commit message; if null, git uses its default.</summary>
    public string? Message { get; init; }

    /// <summary>Gets a value indicating whether to disallow fast-forward (always create a merge commit).</summary>
    public bool NoFastForward { get; init; }
}
