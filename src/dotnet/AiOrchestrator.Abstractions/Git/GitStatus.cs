// <copyright file="GitStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Git;

/// <summary>Represents the working-tree status of a git repository.</summary>
/// <param name="Branch">The name of the currently checked-out branch, or <see langword="null"/> if detached.</param>
/// <param name="HasUncommittedChanges">Whether there are any staged or unstaged modifications.</param>
/// <param name="AheadCount">The number of commits the local branch is ahead of its tracking remote.</param>
/// <param name="BehindCount">The number of commits the local branch is behind its tracking remote.</param>
public sealed record GitStatus(
    string? Branch,
    bool HasUncommittedChanges,
    int AheadCount,
    int BehindCount);
