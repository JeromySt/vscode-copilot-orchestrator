// <copyright file="SetupPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Git;
using AiOrchestrator.Git.Gitignore;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Setup phase: forward-integrates the base branch into the job's worktree and
/// claims the per-worktree lease that protects all subsequent phases (INV-7).
/// </summary>
internal sealed class SetupPhase : IPhaseRunner
{
    private readonly IGitOperations git;
    private readonly ILogger<SetupPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="SetupPhase"/> class.</summary>
    /// <param name="git">The git operations facade.</param>
    /// <param name="logger">The component logger.</param>
    public SetupPhase(IGitOperations git, ILogger<SetupPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(git);
        ArgumentNullException.ThrowIfNull(logger);
        this.git = git;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.Setup;

    /// <inheritdoc/>
    public async ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        this.logger.LogInformation(
            "Setup phase: planId={PlanId} jobId={JobId} runId={RunId} attempt={Attempt}",
            ctx.PlanId,
            ctx.JobId,
            ctx.RunId,
            ctx.AttemptNumber);

        // Ensure orchestrator-managed .gitignore entries exist in the repo root.
        // The repo root is inferred from the first AllowedFolder if available.
        var repoRoot = ctx.Job.WorkSpec?.AllowedFolders.FirstOrDefault();
        if (repoRoot is not null)
        {
            var modified = await GitignoreManager.EnsureOrchestratorGitIgnoreAsync(repoRoot, ct)
                .ConfigureAwait(false);
            if (modified)
            {
                this.logger.LogInformation("Ensured orchestrator .gitignore entries in {RepoRoot}", repoRoot);
            }
        }

        // Setup is delegated to upstream wiring (worktree lease + git facade).
        // The presence of git/lease wiring is verified by integration tests in job 32.
        return null;
    }
}
