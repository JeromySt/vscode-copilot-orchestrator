// <copyright file="HealOrResumeStrategy.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Plan.Models;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Implements the HEAL-RESUME-* truth table from §3.31.4.3:
/// classifies failures and chooses among <see cref="ResumeMode.PhaseResume"/>,
/// <see cref="ResumeMode.AutoHeal"/>, and <see cref="ResumeMode.GiveUp"/>.
/// </summary>
internal sealed class HealOrResumeStrategy
{
    private readonly IClock clock;

    /// <summary>Initializes a new instance of the <see cref="HealOrResumeStrategy"/> class.</summary>
    /// <param name="clock">The clock used to timestamp decisions for downstream telemetry.</param>
    public HealOrResumeStrategy(IClock clock)
    {
        ArgumentNullException.ThrowIfNull(clock);
        this.clock = clock;
    }

    /// <summary>
    /// Decides what to do after a phase failure.
    /// </summary>
    /// <param name="job">The job whose attempt failed (used to read the auto-heal opt-in flag).</param>
    /// <param name="kind">The classified failure kind.</param>
    /// <param name="failedAt">The phase where the failure occurred.</param>
    /// <param name="prevHealAttempts">The number of auto-heal attempts already made for this job.</param>
    /// <param name="maxAutoHealAttempts">The configured cap (HEAL-RESUME-3).</param>
    /// <param name="autoHealEnabled">Whether the job spec opts in to auto-heal (HEAL-RESUME-1).</param>
    /// <returns>A populated <see cref="ResumeDecision"/>.</returns>
    public ResumeDecision Decide(
        JobNode job,
        PhaseFailureKind kind,
        JobPhase failedAt,
        int prevHealAttempts,
        int maxAutoHealAttempts,
        bool autoHealEnabled)
    {
        ArgumentNullException.ThrowIfNull(job);
        _ = this.clock.UtcNow;

        switch (kind)
        {
            case PhaseFailureKind.TransientNetwork:
            case PhaseFailureKind.TransientFileLock:
                return new ResumeDecision
                {
                    Mode = ResumeMode.PhaseResume,
                    ResumeFromPhase = failedAt,
                    Reason = $"Transient {kind} — retry phase {failedAt} without invoking agent.",
                };

            case PhaseFailureKind.AgentMaxTurnsExceeded:
            case PhaseFailureKind.AgentNonZeroExit:
            case PhaseFailureKind.AnalyzerOrTestFailure:
                if (!autoHealEnabled)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.GiveUp,
                        ResumeFromPhase = failedAt,
                        Reason = $"{kind} at {failedAt}; auto-heal disabled by job spec.",
                    };
                }

                if (prevHealAttempts >= maxAutoHealAttempts)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.GiveUp,
                        ResumeFromPhase = failedAt,
                        Reason = $"{kind} at {failedAt}; auto-heal cap of {maxAutoHealAttempts} reached (HEAL-RESUME-3).",
                    };
                }

                return new ResumeDecision
                {
                    Mode = ResumeMode.AutoHeal,
                    ResumeFromPhase = JobPhase.Work,
                    Reason = $"{kind} at {failedAt} — auto-heal attempt {prevHealAttempts + 1}/{maxAutoHealAttempts}.",
                };

            case PhaseFailureKind.MergeConflict:
                if (!autoHealEnabled)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.GiveUp,
                        ResumeFromPhase = failedAt,
                        Reason = "MergeConflict; auto-heal disabled.",
                    };
                }

                if (prevHealAttempts >= maxAutoHealAttempts)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.GiveUp,
                        ResumeFromPhase = failedAt,
                        Reason = $"MergeConflict; auto-heal cap of {maxAutoHealAttempts} reached.",
                    };
                }

                return new ResumeDecision
                {
                    Mode = ResumeMode.AutoHeal,
                    ResumeFromPhase = JobPhase.Work,
                    Reason = $"MergeConflict at {failedAt} — auto-heal attempt {prevHealAttempts + 1}/{maxAutoHealAttempts}.",
                };

            case PhaseFailureKind.RemoteRejected:
                return new ResumeDecision
                {
                    Mode = ResumeMode.GiveUp,
                    ResumeFromPhase = failedAt,
                    Reason = "RemoteRejected — non-recoverable.",
                };

            case PhaseFailureKind.ShellNonZeroExit:
                if (autoHealEnabled && prevHealAttempts < maxAutoHealAttempts)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.AutoHeal,
                        ResumeFromPhase = JobPhase.Work,
                        Reason = $"Shell failure at {failedAt} — auto-heal attempt {prevHealAttempts + 1}/{maxAutoHealAttempts}.",
                    };
                }

                return new ResumeDecision
                {
                    Mode = ResumeMode.GiveUp,
                    ResumeFromPhase = failedAt,
                    Reason = "ShellNonZeroExit — auto-heal exhausted or disabled.",
                };

            case PhaseFailureKind.Timeout:
                return new ResumeDecision
                {
                    Mode = ResumeMode.GiveUp,
                    ResumeFromPhase = failedAt,
                    Reason = $"Timeout at {failedAt}.",
                };

            case PhaseFailureKind.ProcessCrash:
                if (autoHealEnabled && prevHealAttempts < maxAutoHealAttempts)
                {
                    return new ResumeDecision
                    {
                        Mode = ResumeMode.AutoHeal,
                        ResumeFromPhase = JobPhase.Work,
                        Reason = $"Process crash at {failedAt} — auto-heal attempt {prevHealAttempts + 1}/{maxAutoHealAttempts}.",
                    };
                }

                return new ResumeDecision
                {
                    Mode = ResumeMode.GiveUp,
                    ResumeFromPhase = failedAt,
                    Reason = "ProcessCrash — auto-heal exhausted or disabled.",
                };

            case PhaseFailureKind.Internal:
            default:
                return new ResumeDecision
                {
                    Mode = ResumeMode.GiveUp,
                    ResumeFromPhase = failedAt,
                    Reason = $"Internal error at {failedAt} — non-recoverable.",
                };
        }
    }
}
