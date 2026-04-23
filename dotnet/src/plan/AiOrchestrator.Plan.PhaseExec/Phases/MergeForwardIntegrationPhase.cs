// <copyright file="MergeForwardIntegrationPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// MergeForwardIntegration phase: merges the base branch onto the worktree before
/// setup so the job starts from the latest integrated state.
/// </summary>
internal sealed class MergeForwardIntegrationPhase : IPhaseRunner
{
    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.MergeForwardIntegration;

    /// <inheritdoc/>
    public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        // TODO: Merge base branch onto worktree before setup
        return ValueTask.FromResult<CommitSha?>(null);
    }
}
