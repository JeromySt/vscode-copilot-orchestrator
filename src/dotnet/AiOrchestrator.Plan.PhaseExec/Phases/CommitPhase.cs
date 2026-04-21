// <copyright file="CommitPhase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Git;
using AiOrchestrator.HookGate;
using AiOrchestrator.Models.Ids;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Plan.PhaseExec.Phases;

/// <summary>
/// Commit phase: reserves disk via <see cref="IDiskQuota"/> (INV-6, DISK-PLAN-1),
/// invokes the hook-gate (INV-9), then asks <see cref="IGitOperations"/> to stage and commit.
/// Implements expectsNoChanges semantics (INV-10).
/// </summary>
internal sealed class CommitPhase : IPhaseRunner
{
    /// <summary>Default reservation cost charged per commit attempt when no caller-provided estimate is available.</summary>
    public const long DefaultEstimatedBytes = 1024L * 1024L; // 1 MiB

    private readonly IGitOperations git;
    private readonly IHookGateClient hookGate;
    private readonly IDiskQuota diskQuota;
    private readonly ICommitInputs commitInputs;
    private readonly ILogger<CommitPhase> logger;

    /// <summary>Initializes a new instance of the <see cref="CommitPhase"/> class.</summary>
    /// <param name="git">The git operations facade.</param>
    /// <param name="hookGate">The hook-gate client.</param>
    /// <param name="diskQuota">The per-plan disk quota tracker.</param>
    /// <param name="commitInputs">Provides per-job commit inputs (message, expectsNoChanges, repo path).</param>
    /// <param name="logger">The component logger.</param>
    public CommitPhase(
        IGitOperations git,
        IHookGateClient hookGate,
        IDiskQuota diskQuota,
        ICommitInputs commitInputs,
        ILogger<CommitPhase> logger)
    {
        ArgumentNullException.ThrowIfNull(git);
        ArgumentNullException.ThrowIfNull(hookGate);
        ArgumentNullException.ThrowIfNull(diskQuota);
        ArgumentNullException.ThrowIfNull(commitInputs);
        ArgumentNullException.ThrowIfNull(logger);
        this.git = git;
        this.hookGate = hookGate;
        this.diskQuota = diskQuota;
        this.commitInputs = commitInputs;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public JobPhase Phase => JobPhase.Commit;

    /// <inheritdoc/>
    public async ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var inputs = await this.commitInputs.GetAsync(ctx, ct).ConfigureAwait(false);

        // INV-6 / DISK-PLAN-1: reserve BEFORE writing.
        var bytes = inputs.EstimatedBytes <= 0 ? DefaultEstimatedBytes : inputs.EstimatedBytes;
        if (!this.diskQuota.TryReserve(ctx.PlanId, bytes))
        {
            throw new DiskQuotaExceededException(
                ctx.PlanId,
                bytes,
                $"DiskQuotaExceeded reserving {bytes} bytes for commit on plan {ctx.PlanId}.");
        }

        try
        {
            var status = await this.git.StatusAsync(inputs.Repo, ct).ConfigureAwait(false);
            var hasChanges = status.HasUncommittedChanges;

            // INV-10: expectsNoChanges semantics.
            if (inputs.ExpectsNoChanges)
            {
                if (hasChanges)
                {
                    throw new PhaseExecutionException(
                        PhaseFailureKind.AnalyzerOrTestFailure,
                        JobPhase.Commit,
                        "Commit phase: expectsNoChanges=true but worktree has uncommitted changes.");
                }

                this.logger.LogInformation("Commit phase: expectsNoChanges satisfied for jobId={JobId}.", ctx.JobId);
                this.diskQuota.Release(ctx.PlanId, bytes);
                return null;
            }

            if (!hasChanges)
            {
                throw new PhaseExecutionException(
                    PhaseFailureKind.AnalyzerOrTestFailure,
                    JobPhase.Commit,
                    "Commit phase: expectsNoChanges=false but worktree has no changes to commit.");
            }

            // INV-9: HookGate BEFORE git commit.
            try
            {
                _ = await this.hookGate.CheckInAsync(inputs.HookCheckInRequest, ct).ConfigureAwait(false);
            }
            catch (AiOrchestrator.HookGate.Exceptions.HookApprovalDeniedException denied)
            {
                throw new PhaseExecutionException(
                    PhaseFailureKind.Internal,
                    JobPhase.Commit,
                    $"HookGate denied commit: {denied.Message}",
                    denied);
            }

            var sha = await this.git.CommitAsync(inputs.Repo, inputs.Message, inputs.Author, ct).ConfigureAwait(false);
            this.logger.LogInformation("Commit phase: produced commit {Sha} for jobId={JobId}.", sha, ctx.JobId);
            return sha;
        }
        catch
        {
            this.diskQuota.Release(ctx.PlanId, bytes);
            throw;
        }
    }
}
