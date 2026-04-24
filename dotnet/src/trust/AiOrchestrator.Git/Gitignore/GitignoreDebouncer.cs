// <copyright file="GitignoreDebouncer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace AiOrchestrator.Git.Gitignore;

/// <summary>
/// Debounces .gitignore entry writes to avoid conflicting with git branch switches.
/// After a branch change, waits a configurable delay before writing entries,
/// allowing the checkout to complete cleanly.
///
/// If the working tree has uncommitted .gitignore changes when a branch switch
/// is detected, stashes them first and re-applies after the new branch is active.
/// </summary>
public sealed class GitignoreDebouncer : IAsyncDisposable
{
    /// <summary>The default debounce delay applied after branch changes.</summary>
    public static readonly TimeSpan DefaultDelay = TimeSpan.FromSeconds(30);

    private readonly ConcurrentDictionary<string, DebouncerState> repos = new(StringComparer.OrdinalIgnoreCase);
    private readonly TimeSpan delay;
    private readonly ILogger<GitignoreDebouncer> logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="GitignoreDebouncer"/> class.
    /// </summary>
    /// <param name="delay">
    /// How long to wait after the last <see cref="RequestEnsure"/> call before
    /// flushing entries.  Defaults to <see cref="DefaultDelay"/> (30 s).
    /// </param>
    /// <param name="logger">Optional logger.</param>
    public GitignoreDebouncer(TimeSpan? delay = null, ILogger<GitignoreDebouncer>? logger = null)
    {
        this.delay = delay ?? DefaultDelay;
        this.logger = logger ?? NullLogger<GitignoreDebouncer>.Instance;
    }

    /// <summary>
    /// Requests that orchestrator .gitignore entries be ensured for the given repo.
    /// The actual write is debounced — if called multiple times within the delay
    /// window, only one write occurs after the delay expires.
    /// </summary>
    /// <param name="repoRoot">Absolute path to the repository root.</param>
    public void RequestEnsure(string repoRoot)
    {
        ArgumentNullException.ThrowIfNull(repoRoot);
        var state = this.repos.GetOrAdd(repoRoot, _ => new DebouncerState());
        state.RequestWrite(repoRoot, this.delay, this.logger);
    }

    /// <summary>
    /// Called when a branch switch is detected.  Stashes any uncommitted .gitignore
    /// changes, then schedules a debounced re-apply on the new branch.
    /// </summary>
    /// <param name="repoRoot">Absolute path to the repository root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
    public async Task OnBranchSwitchAsync(string repoRoot, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(repoRoot);

        var hasChanges = await HasUncommittedGitignoreAsync(repoRoot, ct).ConfigureAwait(false);

        if (hasChanges)
        {
            try
            {
                await RunGitAsync(repoRoot, "stash push -m \"aio-gitignore-autostash\" -- .gitignore", ct)
                    .ConfigureAwait(false);
                this.logger.LogDebug("Stashed uncommitted .gitignore changes in {Repo}", repoRoot);
            }
            catch (Exception ex)
            {
                this.logger.LogWarning(ex, "Failed to stash .gitignore in {Repo}", repoRoot);
            }
        }

        this.RequestEnsure(repoRoot);
    }

    /// <summary>
    /// Immediately ensures entries are present and committed (bypasses debounce).
    /// Used at daemon startup and plan creation.
    /// </summary>
    /// <param name="repoRoot">Absolute path to the repository root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>true</c> if a commit was made; otherwise <c>false</c>.</returns>
    public Task<bool> EnsureNowAsync(string repoRoot, CancellationToken ct = default)
        => GitignoreCommitter.EnsureAndCommitAsync(repoRoot, ct);

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        foreach (var kvp in this.repos)
        {
            kvp.Value.Cancel();
        }

        this.repos.Clear();
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async Task<bool> HasUncommittedGitignoreAsync(string repoRoot, CancellationToken ct)
    {
        var output = await RunGitAsync(repoRoot, "status --porcelain -- .gitignore", ct)
            .ConfigureAwait(false);
        return !string.IsNullOrWhiteSpace(output);
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
        return output.Trim();
    }

    private sealed class DebouncerState
    {
        private CancellationTokenSource? pendingCts;
        private readonly object sync = new();

        public void RequestWrite(string repoRoot, TimeSpan writeDelay, ILogger logger)
        {
            lock (this.sync)
            {
                this.pendingCts?.Cancel();
                this.pendingCts?.Dispose();
                this.pendingCts = new CancellationTokenSource();
                var ct = this.pendingCts.Token;

                _ = Task.Run(
                    async () =>
                    {
                        try
                        {
                            await Task.Delay(writeDelay, ct).ConfigureAwait(false);

                            var committed = await GitignoreCommitter.EnsureAndCommitAsync(repoRoot, ct)
                                .ConfigureAwait(false);

                            if (committed)
                            {
                                logger.LogInformation(
                                    "Debounced .gitignore entries committed to {Repo}", repoRoot);
                            }
                        }
                        catch (OperationCanceledException)
                        {
                            // Debounce reset — a newer request superseded this one.
                        }
                        catch (Exception ex)
                        {
                            logger.LogWarning(
                                ex,
                                "Failed to commit debounced .gitignore entries to {Repo}",
                                repoRoot);
                        }
                    },
                    CancellationToken.None);
            }
        }

        public void Cancel()
        {
            lock (this.sync)
            {
                this.pendingCts?.Cancel();
                this.pendingCts?.Dispose();
                this.pendingCts = null;
            }
        }
    }
}
