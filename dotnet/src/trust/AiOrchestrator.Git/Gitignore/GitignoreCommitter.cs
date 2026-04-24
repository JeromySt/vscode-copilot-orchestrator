// <copyright file="GitignoreCommitter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;

namespace AiOrchestrator.Git.Gitignore;

/// <summary>
/// Ensures orchestrator .gitignore entries are committed to the repository
/// before any plan execution begins. This prevents runtime artifacts from
/// appearing as uncommitted changes in the user's working tree.
/// </summary>
public sealed class GitignoreCommitter
{
    /// <summary>
    /// The commit message used when committing orchestrator .gitignore entries.
    /// </summary>
    public const string CommitMessage = "chore: add orchestrator .gitignore entries";

    private readonly IProcessSpawner spawner;

    /// <summary>
    /// Initializes a new instance of the <see cref="GitignoreCommitter"/> class.
    /// </summary>
    /// <param name="spawner">Process spawner used to launch <c>git</c>.</param>
    public GitignoreCommitter(IProcessSpawner spawner)
    {
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
    }

    /// <summary>
    /// Ensures all orchestrator .gitignore entries are present and committed.
    /// If entries are already present, this is a no-op.
    /// </summary>
    /// <returns><c>true</c> if a commit was made, <c>false</c> if already up-to-date.</returns>
    public async Task<bool> EnsureAndCommitAsync(
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
        await this.RunGitAsync(repoRoot, ["add", ".gitignore"], ct).ConfigureAwait(false);

        // 3. Commit only if there are staged changes
        var status = await this.RunGitAsync(repoRoot, ["diff", "--cached", "--name-only"], ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(status))
        {
            return false;
        }

        await this.RunGitAsync(
            repoRoot,
            ["commit", "-m", CommitMessage, "--no-verify"],
            ct).ConfigureAwait(false);

        return true;
    }

    private async Task<string> RunGitAsync(string workDir, string[] args, CancellationToken ct)
    {
        // ProcessSpec doesn't carry a WorkingDirectory — pass -C <workDir> to git instead.
        var argv = ImmutableArray.CreateBuilder<string>(args.Length + 2);
        argv.Add("-C");
        argv.Add(workDir);
        argv.AddRange(args);

        var spec = new ProcessSpec
        {
            Producer = "AiOrchestrator.Git",
            Description = $"git {args[0]}",
            Executable = "git",
            Arguments = argv.ToImmutable(),
        };

        await using var handle = await this.spawner.SpawnAsync(spec, ct).ConfigureAwait(false);

        var stdout = await ReadAllAsync(handle.StandardOut, ct).ConfigureAwait(false);
        var stderr = await ReadAllAsync(handle.StandardError, ct).ConfigureAwait(false);
        var exitCode = await handle.WaitForExitAsync(ct).ConfigureAwait(false);

        if (exitCode != 0)
        {
            throw new InvalidOperationException(
                $"git {string.Join(' ', args)} failed (exit {exitCode}) in {workDir}: {stderr}");
        }

        return stdout.Trim();
    }

    private static async Task<string> ReadAllAsync(System.IO.Pipelines.PipeReader reader, CancellationToken ct)
    {
        var sb = new StringBuilder();
        while (true)
        {
            var read = await reader.ReadAsync(ct).ConfigureAwait(false);
            foreach (var segment in read.Buffer)
            {
                sb.Append(Encoding.UTF8.GetString(segment.Span));
            }

            reader.AdvanceTo(read.Buffer.End);
            if (read.IsCompleted)
            {
                break;
            }
        }

        return sb.ToString();
    }
}
