// <copyright file="WorktreeHandle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Git.Shell;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git;

/// <summary>A handle to a worktree created by <see cref="GitOperations.AddWorktreeAsync"/>.</summary>
/// <remarks>
/// Disposing the handle removes the worktree (INV-5).
/// </remarks>
public sealed class WorktreeHandle : IAsyncDisposable
{
    private readonly GitShellInvoker shell;
    private readonly AbsolutePath repoRoot;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="WorktreeHandle"/> class.</summary>
    /// <param name="shell">Shell invoker used to remove the worktree on dispose.</param>
    /// <param name="repoRoot">The main repository root the worktree belongs to.</param>
    /// <param name="path">The absolute path of the new worktree.</param>
    /// <param name="branch">The branch checked out in the worktree.</param>
    internal WorktreeHandle(GitShellInvoker shell, AbsolutePath repoRoot, AbsolutePath path, string branch)
    {
        this.shell = shell;
        this.repoRoot = repoRoot;
        this.Path = path;
        this.Branch = branch;
    }

    /// <summary>Gets the absolute path of the worktree.</summary>
    public AbsolutePath Path { get; }

    /// <summary>Gets the branch checked out in the worktree.</summary>
    public string Branch { get; }

    /// <summary>Removes the worktree from disk and from git's bookkeeping.</summary>
    /// <returns>A task that completes when the removal is done.</returns>
    public async ValueTask DisposeAsync()
    {
        if (this.disposed)
        {
            return;
        }

        this.disposed = true;
        _ = await this.shell.RunAsync(
            GitVerb.Worktree,
            ImmutableArray.Create("remove", "--force", this.Path.Value),
            this.repoRoot,
            CancellationToken.None).ConfigureAwait(false);
    }
}
