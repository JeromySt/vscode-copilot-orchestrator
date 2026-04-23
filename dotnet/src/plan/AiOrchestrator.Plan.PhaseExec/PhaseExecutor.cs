// <copyright file="PhaseExecutor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.PhaseExec.Phases;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Runs the per-job phase machine (MergeFI → Setup → Prechecks → Work → Commit → Postchecks → MergeRI → Done)
/// per §3.12.6, with HEAL-RESUME-* recovery (§3.31.4.3) and DISK-PLAN-* enforcement (§3.31.3.3).
/// </summary>
public sealed class PhaseExecutor : IPhaseExecutor
{
    /// <summary>The fixed phase pipeline order (INV-1).</summary>
    public static readonly IReadOnlyList<JobPhase> PhaseOrder = new[]
    {
        JobPhase.MergeForwardIntegration,
        JobPhase.Setup,
        JobPhase.Prechecks,
        JobPhase.Work,
        JobPhase.Commit,
        JobPhase.Postchecks,
        JobPhase.MergeReverseIntegration,
    };

    private readonly IPlanStore store;
    private readonly IEventBus bus;
    private readonly IClock clock;
    private readonly IOptionsMonitor<PhaseOptions> opts;
    private readonly ILogger<PhaseExecutor> logger;
    private readonly HealOrResumeStrategy healStrategy;
    private readonly IReadOnlyDictionary<JobPhase, IPhaseRunner> phaseRunners;
    private readonly Func<JobNode, bool> autoHealEnabledSelector;

    /// <summary>Initializes a new instance of the <see cref="PhaseExecutor"/> class.</summary>
    /// <param name="store">The plan store for loading job state and recording attempts.</param>
    /// <param name="bus">The event bus for publishing phase telemetry.</param>
    /// <param name="clock">The clock used for timing and timestamps.</param>
    /// <param name="opts">Phase options (timeouts, heal cap).</param>
    /// <param name="logger">The component logger.</param>
    /// <param name="runners">The six phase runners (one per <see cref="JobPhase"/>).</param>
    /// <param name="autoHealEnabledSelector">
    /// Selector returning whether auto-heal is opted in for a given job.
    /// Defaults to <see langword="true"/>.
    /// </param>
    public PhaseExecutor(
        IPlanStore store,
        IEventBus bus,
        IClock clock,
        IOptionsMonitor<PhaseOptions> opts,
        ILogger<PhaseExecutor> logger,
        IEnumerable<IPhaseRunner> runners,
        Func<JobNode, bool>? autoHealEnabledSelector = null)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(runners);

        this.store = store;
        this.bus = bus;
        this.clock = clock;
        this.opts = opts;
        this.logger = logger;
        this.healStrategy = new HealOrResumeStrategy(clock);
        this.autoHealEnabledSelector = autoHealEnabledSelector ?? (_ => true);

        var dict = new Dictionary<JobPhase, IPhaseRunner>();
        foreach (var r in runners)
        {
            dict[r.Phase] = r;
        }

        foreach (var p in PhaseOrder)
        {
            if (!dict.ContainsKey(p))
            {
                throw new ArgumentException($"Missing phase runner for {p}.", nameof(runners));
            }
        }

        this.phaseRunners = dict;
    }

    /// <inheritdoc/>
    public async ValueTask<PhaseExecResult> ExecuteAsync(PlanId planId, JobId jobId, RunId runId, CancellationToken ct)
    {
        var plan = await this.store.LoadAsync(planId, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Plan {planId} not found.");

        if (!plan.Jobs.TryGetValue(jobId.ToString(), out var job))
        {
            throw new InvalidOperationException($"Job {jobId} not found in plan {planId}.");
        }

        var options = this.opts.CurrentValue;
        var attemptCount = 0;
        var healAttempts = 0;
        var phaseResumeAttempts = 0;
        var startPhase = JobPhase.MergeForwardIntegration;
        var lastEndedAtPhase = JobPhase.MergeForwardIntegration;
        var autoHealEnabled = this.autoHealEnabledSelector(job);

        while (true)
        {
            attemptCount++;
            var attemptStarted = this.clock.UtcNow;
            var phaseTimings = new List<PhaseTiming>();
            CommitSha? commitSha = null;
            JobPhase currentPhase = startPhase;
            var isAutoHeal = startPhase == JobPhase.Work && healAttempts > 0;

            try
            {
                foreach (var phase in PhaseOrder)
                {
                    if (phase < startPhase)
                    {
                        // INV-4: don't repeat already-successful prior phases.
                        continue;
                    }

                    currentPhase = phase;
                    lastEndedAtPhase = phase;
                    var phaseStarted = this.clock.UtcNow;

                    var ctx = new PhaseRunContext
                    {
                        PlanId = planId,
                        JobId = jobId,
                        RunId = runId,
                        Job = job,
                        AttemptNumber = attemptCount,
                        IsAutoHealAttempt = isAutoHeal && phase == JobPhase.Work,
                    };

                    var sha = await this.RunPhaseWithTimeoutAsync(phase, ctx, options, ct).ConfigureAwait(false);
                    if (sha is not null)
                    {
                        commitSha = sha;
                    }

                    phaseTimings.Add(new PhaseTiming
                    {
                        Phase = phase.ToString(),
                        StartedAt = phaseStarted,
                        CompletedAt = this.clock.UtcNow,
                    });
                }

                // All phases succeeded — record success attempt and return.
                await this.RecordAttemptAsync(
                    planId,
                    jobId,
                    new JobAttempt
                    {
                        AttemptNumber = attemptCount,
                        StartedAt = attemptStarted,
                        CompletedAt = this.clock.UtcNow,
                        Status = JobStatus.Succeeded,
                        ErrorMessage = null,
                        PhaseTimings = phaseTimings,
                    },
                    ct).ConfigureAwait(false);

                return new PhaseExecResult
                {
                    FinalStatus = JobStatus.Succeeded,
                    EndedAtPhase = JobPhase.Done,
                    CommitSha = commitSha,
                    FailureReason = null,
                    AttemptCount = attemptCount,
                };
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                await this.RecordAttemptAsync(
                    planId,
                    jobId,
                    new JobAttempt
                    {
                        AttemptNumber = attemptCount,
                        StartedAt = attemptStarted,
                        CompletedAt = this.clock.UtcNow,
                        Status = JobStatus.Canceled,
                        ErrorMessage = "Canceled by caller.",
                        PhaseTimings = phaseTimings,
                    },
                    ct: CancellationToken.None).ConfigureAwait(false);

                return new PhaseExecResult
                {
                    FinalStatus = JobStatus.Canceled,
                    EndedAtPhase = currentPhase,
                    CommitSha = commitSha,
                    FailureReason = "Canceled by caller.",
                    AttemptCount = attemptCount,
                };
            }
            catch (PhaseExecutionException ex)
            {
                lastEndedAtPhase = ex.Phase;

                // INV-2: record attempt with the failure.
                await this.RecordAttemptAsync(
                    planId,
                    jobId,
                    new JobAttempt
                    {
                        AttemptNumber = attemptCount,
                        StartedAt = attemptStarted,
                        CompletedAt = this.clock.UtcNow,
                        Status = JobStatus.Failed,
                        ErrorMessage = $"{ex.Kind}@{ex.Phase}: {ex.Message}",
                        PhaseTimings = phaseTimings,
                    },
                    ct).ConfigureAwait(false);

                var decision = this.healStrategy.Decide(
                    job,
                    ex.Kind,
                    ex.Phase,
                    healAttempts,
                    options.MaxAutoHealAttempts,
                    autoHealEnabled);

                this.logger.LogInformation(
                    "Phase {Phase} failed ({Kind}); decision={Mode} reason={Reason}",
                    ex.Phase,
                    ex.Kind,
                    decision.Mode,
                    decision.Reason);

                switch (decision.Mode)
                {
                    case ResumeMode.AutoHeal:
                        healAttempts++;
                        startPhase = decision.ResumeFromPhase;
                        continue;

                    case ResumeMode.PhaseResume:
                        phaseResumeAttempts++;
                        if (phaseResumeAttempts > options.MaxPhaseResumeAttempts)
                        {
                            return new PhaseExecResult
                            {
                                FinalStatus = JobStatus.Failed,
                                EndedAtPhase = ex.Phase,
                                CommitSha = commitSha,
                                FailureReason = $"PhaseResume exhausted ({options.MaxPhaseResumeAttempts}) on {ex.Kind}.",
                                AttemptCount = attemptCount,
                            };
                        }

                        startPhase = decision.ResumeFromPhase;
                        continue;

                    case ResumeMode.GiveUp:
                    default:
                        return new PhaseExecResult
                        {
                            FinalStatus = JobStatus.Failed,
                            EndedAtPhase = ex.Phase,
                            CommitSha = commitSha,
                            FailureReason = decision.Reason,
                            AttemptCount = attemptCount,
                        };
                }
            }
            catch (DiskQuotaExceededException ex)
            {
                await this.RecordAttemptAsync(
                    planId,
                    jobId,
                    new JobAttempt
                    {
                        AttemptNumber = attemptCount,
                        StartedAt = attemptStarted,
                        CompletedAt = this.clock.UtcNow,
                        Status = JobStatus.Failed,
                        ErrorMessage = ex.Message,
                        PhaseTimings = phaseTimings,
                    },
                    ct).ConfigureAwait(false);

                return new PhaseExecResult
                {
                    FinalStatus = JobStatus.Failed,
                    EndedAtPhase = JobPhase.Commit,
                    CommitSha = null,
                    FailureReason = ex.Message,
                    AttemptCount = attemptCount,
                };
            }
            catch (Exception ex)
            {
                this.logger.LogError(ex, "Unhandled phase failure at {Phase}.", currentPhase);

                await this.RecordAttemptAsync(
                    planId,
                    jobId,
                    new JobAttempt
                    {
                        AttemptNumber = attemptCount,
                        StartedAt = attemptStarted,
                        CompletedAt = this.clock.UtcNow,
                        Status = JobStatus.Failed,
                        ErrorMessage = $"Internal@{currentPhase}: {ex.Message}",
                        PhaseTimings = phaseTimings,
                    },
                    ct).ConfigureAwait(false);

                return new PhaseExecResult
                {
                    FinalStatus = JobStatus.Failed,
                    EndedAtPhase = currentPhase,
                    CommitSha = commitSha,
                    FailureReason = $"Internal: {ex.Message}",
                    AttemptCount = attemptCount,
                };
            }
        }
    }

    private async ValueTask<CommitSha?> RunPhaseWithTimeoutAsync(
        JobPhase phase,
        PhaseRunContext ctx,
        PhaseOptions options,
        CancellationToken ct)
    {
        var timeout = phase switch
        {
            JobPhase.MergeForwardIntegration => options.MergeFiTimeout,
            JobPhase.Setup => options.SetupTimeout,
            JobPhase.Prechecks => options.PrechecksTimeout,
            JobPhase.Work => options.WorkTimeout,
            JobPhase.Commit => options.CommitTimeout,
            JobPhase.Postchecks => options.PostchecksTimeout,
            JobPhase.MergeReverseIntegration => options.MergeRiTimeout,
            _ => TimeSpan.FromMinutes(5),
        };

        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

        try
        {
            return await this.phaseRunners[phase].RunAsync(ctx, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            // INV-11: timeout becomes PhaseFailureKind.Timeout.
            throw new PhaseExecutionException(
                PhaseFailureKind.Timeout,
                phase,
                $"Phase {phase} exceeded timeout {timeout}.");
        }
    }

    private async ValueTask RecordAttemptAsync(PlanId planId, JobId jobId, JobAttempt attempt, CancellationToken ct)
    {
        try
        {
            var idemKey = IdempotencyKey.FromGuid(Guid.NewGuid());
            await this.store.MutateAsync(
                planId,
                new JobAttemptRecorded(0, idemKey, this.clock.UtcNow, jobId.ToString(), attempt),
                idemKey,
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.logger.LogWarning(ex, "Failed to record attempt for job {JobId}.", jobId);
        }

        try
        {
            await this.bus.PublishAsync(
                new PhaseAttemptCompletedEvent
                {
                    PlanId = planId,
                    JobId = jobId,
                    At = this.clock.UtcNow,
                    Attempt = attempt,
                },
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.logger.LogDebug(ex, "PhaseAttemptCompletedEvent publish failed.");
        }

        _ = Activity.Current?.AddEvent(new ActivityEvent($"phase-attempt-{attempt.AttemptNumber}"));
    }
}
