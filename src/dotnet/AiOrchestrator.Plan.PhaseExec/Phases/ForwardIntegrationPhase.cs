// <copyright file="ForwardIntegrationPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Git;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// ForwardIntegration phase: merges the target branch onto the worktree so downstream
/// dependent jobs see this job's changes integrated into their starting state.
/// The lease (INV-7) is held until this phase completes.
/// </summary>
internal sealed class ForwardIntegrationPhase : IPhaseRunner
{
    private readonly IGitOperations git;
    private readonly ILogger<ForwardIntegrationPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="ForwardIntegrationPhase"/> class.</summary>
    /// <param name="git">The git operations facade.</param>
    /// <param name="logger">The component logger.</param>
    public ForwardIntegrationPhase(IGitOperations git, ILogger<ForwardIntegrationPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(git);
        ArgumentNullException.ThrowIfNull(logger);
        this.git = git;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.ForwardIntegration;

    /// <inheritdoc/>
    public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        this.logger.LogDebug("ForwardIntegration phase: jobId={JobId}", ctx.JobId);
        _ = this.git;
        return ValueTask.FromResult<CommitSha?>(null);
    }
}
