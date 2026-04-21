// <copyright file="WorktreeRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a new linked worktree to create.</summary>
public sealed record WorktreeRequest
{
    /// <summary>Gets the absolute path of the new worktree.</summary>
    public required AbsolutePath Path { get; init; }

    /// <summary>Gets the branch to check out in the worktree.</summary>
    public required string Branch { get; init; }

    /// <summary>Gets a value indicating whether to create the branch if it does not exist.</summary>
    public bool CreateBranch { get; init; }

    /// <summary>Gets a value indicating whether to lock the worktree on creation.</summary>
    public bool Lock { get; init; } = true;
}
