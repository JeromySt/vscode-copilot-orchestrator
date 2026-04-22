// <copyright file="IGitOperations.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.Git;

/// <summary>
/// Provides git repository operations used by the orchestrator's execution engine.
/// All mutations are performed on the file system; callers are responsible for ensuring
/// the target repository exists and is in a valid state.
/// </summary>
public interface IGitOperations
{
    /// <summary>Returns the current working-tree status of the repository at <paramref name="repo"/>.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="GitStatus"/> describing the current state of the repository.</returns>
    ValueTask<GitStatus> StatusAsync(AbsolutePath repo, CancellationToken ct);

    /// <summary>Fetches updates from the specified remote.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="remote">The name of the remote to fetch from (e.g., <c>origin</c>).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the fetch is done.</returns>
    ValueTask FetchAsync(AbsolutePath repo, string remote, CancellationToken ct);

    /// <summary>Stages all changes and creates a commit with the given message and author.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="message">The commit message.</param>
    /// <param name="author">The authenticated principal whose identity is used as the git author.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The <see cref="CommitSha"/> of the newly created commit.</returns>
    ValueTask<CommitSha> CommitAsync(AbsolutePath repo, string message, AuthContext author, CancellationToken ct);

    /// <summary>Creates a new linked worktree at <paramref name="worktreePath"/> checked out to <paramref name="branch"/>.</summary>
    /// <param name="repo">The absolute path to the main repository.</param>
    /// <param name="worktreePath">The absolute path where the worktree should be created.</param>
    /// <param name="branch">The branch to check out in the new worktree.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the worktree is ready.</returns>
    ValueTask CreateWorktreeAsync(AbsolutePath repo, AbsolutePath worktreePath, string branch, CancellationToken ct);

    /// <summary>Removes the linked worktree at <paramref name="worktreePath"/>.</summary>
    /// <param name="repo">The absolute path to the main repository.</param>
    /// <param name="worktreePath">The absolute path of the worktree to remove.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the worktree has been removed.</returns>
    ValueTask RemoveWorktreeAsync(AbsolutePath repo, AbsolutePath worktreePath, CancellationToken ct);

    /// <summary>Merges the specified branch into the current HEAD of the repository.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="sourceBranch">The name of the branch to merge.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the merge is done.</returns>
    ValueTask MergeAsync(AbsolutePath repo, string sourceBranch, CancellationToken ct);

    /// <summary>Resets the working tree to the specified commit, discarding local changes.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="sha">The commit to reset to.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the reset is done.</returns>
    ValueTask ResetHardAsync(AbsolutePath repo, CommitSha sha, CancellationToken ct);

    /// <summary>Reads the SHA of the HEAD commit in the repository.</summary>
    /// <param name="repo">The absolute path to the repository root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The <see cref="CommitSha"/> of the current HEAD.</returns>
    ValueTask<CommitSha> GetHeadShaAsync(AbsolutePath repo, CancellationToken ct);
}
