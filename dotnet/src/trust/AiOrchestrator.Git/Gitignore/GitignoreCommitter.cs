// <copyright file="GitignoreCommitter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Git.Gitignore;

/// <summary>
/// Ensures orchestrator .gitignore entries are committed to the repository
/// before any plan execution begins. This prevents runtime artifacts from
/// appearing as uncommitted changes in the user's working tree.
/// </summary>
public static class GitignoreCommitter
{
    /// <summary>
    /// The commit message used when committing orchestrator .gitignore entries.
    /// </summary>
    public const string CommitMessage = "chore: add orchestrator .gitignore entries";

    /// <summary>
    /// Ensures all orchestrator .gitignore entries are present and committed.
    /// If entries are already present, this is a no-op.
    /// </summary>
    /// <returns><c>true</c> if a commit was made, <c>false</c> if already up-to-date.</returns>
    public static async Task<bool> EnsureAndCommitAsync(
        string repoRoot,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(repoRoot);

        // 1. Ensure entries in the working tree
        var modified = await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(repoRoot, ct)
            .ConfigureAwait(false);

        if (!modified)
        {
            return false;
        }

        // 2. Stage the .gitignore
        await RunGitAsync(repoRoot, "add .gitignore", ct).ConfigureAwait(false);

        // 3. Commit only if there are staged changes
        var status = await RunGitAsync(repoRoot, "diff --cached --name-only", ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(status))
        {
            return false;
        }

        await RunGitAsync(
            repoRoot,
            $"commit -m \"{CommitMessage}\" --no-verify",
            ct).ConfigureAwait(false);

        return true;
    }

    private static async Task<string> RunGitAsync(string workDir, string args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("git", args)
        {
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start git process");
        var output = await proc.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);

        if (proc.ExitCode != 0)
        {
            var stderr = await proc.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException(
                $"git {args} failed (exit {proc.ExitCode}) in {workDir}: {stderr}");
        }

        return output.Trim();
    }
}
