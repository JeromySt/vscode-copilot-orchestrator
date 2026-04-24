// <copyright file="JobStatusTransitions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Frozen;
using System.Collections.Generic;

namespace AiOrchestrator.Plan.Models;

/// <summary>Encodes the allowed <see cref="JobStatus"/> state transitions as a static constant set.</summary>
public readonly record struct JobStatusTransitions
{
    /// <summary>Gets the set of all allowed (from, to) status transitions.</summary>
    public static readonly FrozenSet<(JobStatus From, JobStatus To)> AllowedTransitions =
        new HashSet<(JobStatus, JobStatus)>
        {
            (JobStatus.Pending, JobStatus.Ready),
            (JobStatus.Pending, JobStatus.Canceled),
            (JobStatus.Pending, JobStatus.Blocked),
            (JobStatus.Pending, JobStatus.Skipped),
            (JobStatus.Ready, JobStatus.Scheduled),
            (JobStatus.Ready, JobStatus.Canceled),
            (JobStatus.Ready, JobStatus.Blocked),
            (JobStatus.Scheduled, JobStatus.Running),
            (JobStatus.Scheduled, JobStatus.Canceled),
            (JobStatus.Running, JobStatus.Succeeded),
            (JobStatus.Running, JobStatus.Failed),
            (JobStatus.Running, JobStatus.Canceled),
            (JobStatus.Running, JobStatus.CompletedSplit),
            (JobStatus.CompletedSplit, JobStatus.Succeeded),
            (JobStatus.CompletedSplit, JobStatus.Failed),
            (JobStatus.Failed, JobStatus.Ready),
            (JobStatus.Failed, JobStatus.Running),
            (JobStatus.Failed, JobStatus.Blocked),
            (JobStatus.Failed, JobStatus.Pending),
            (JobStatus.Canceled, JobStatus.Pending),
            (JobStatus.Blocked, JobStatus.Pending),
        }.ToFrozenSet();

    /// <summary>Returns <c>true</c> if the transition from <paramref name="from"/> to <paramref name="to"/> is allowed.</summary>
    public static bool IsAllowed(JobStatus from, JobStatus to) =>
        AllowedTransitions.Contains((from, to));

    /// <summary>Throws <see cref="InvalidOperationException"/> if the transition is not allowed.</summary>
    public static void Validate(JobStatus from, JobStatus to)
    {
        if (!IsAllowed(from, to))
        {
            throw new InvalidOperationException(
                $"Invalid job status transition: {from} → {to}");
        }
    }
}
