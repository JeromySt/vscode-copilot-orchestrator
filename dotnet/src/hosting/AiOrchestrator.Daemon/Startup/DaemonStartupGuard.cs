// <copyright file="DaemonStartupGuard.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Git.Gitignore;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.Startup;

/// <summary>
/// Ensures essential runtime preconditions are met before the daemon writes
/// any files to the repo. Called as the very first step of daemon initialization,
/// BEFORE logging file sinks are opened.
/// </summary>
public static class DaemonStartupGuard
{
    /// <summary>
    /// Ensures .gitignore entries are committed to the repo so that runtime
    /// artifacts (.aio/, .worktrees/, etc.) don't appear as uncommitted changes.
    /// Must be called BEFORE any file-based logger is opened.
    /// </summary>
    public static async Task EnsureGitignoreAsync(
        string repoRoot,
        ILogger? logger = null,
        CancellationToken ct = default)
    {
        try
        {
            var committed = await GitignoreCommitter.EnsureAndCommitAsync(repoRoot, ct)
                .ConfigureAwait(false);

            if (committed)
            {
                logger?.LogInformation(
                    "Committed orchestrator .gitignore entries to {RepoRoot}",
                    repoRoot);
            }
        }
        catch (Exception ex)
        {
            // Non-fatal — the daemon should still start even if we can't
            // write .gitignore (e.g., the repo is in detached HEAD, or
            // the working tree is locked by another process).
            logger?.LogWarning(
                ex,
                "Failed to ensure .gitignore entries at {RepoRoot}. " +
                "Runtime artifacts may appear as uncommitted changes.",
                repoRoot);
        }
    }
}
