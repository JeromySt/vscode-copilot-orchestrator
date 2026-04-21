// <copyright file="JobStatusTransitions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Frozen;
using System.Collections.Generic;

namespace AiOrchestrator.Models;

/// <summary>Encodes the allowed <see cref="JobStatus"/> state transitions as a static constant set.</summary>
public readonly record struct JobStatusTransitions
{
    /// <summary>Gets the set of all allowed (from, to) status transitions.</summary>
    public static readonly FrozenSet<(JobStatus From, JobStatus To)> AllowedTransitions =
        new HashSet<(JobStatus, JobStatus)>
        {
            (JobStatus.Pending, JobStatus.Ready),
            (JobStatus.Pending, JobStatus.Canceled),
            (JobStatus.Ready, JobStatus.Scheduled),
            (JobStatus.Ready, JobStatus.Canceled),
            (JobStatus.Scheduled, JobStatus.Running),
            (JobStatus.Scheduled, JobStatus.Canceled),
            (JobStatus.Running, JobStatus.Succeeded),
            (JobStatus.Running, JobStatus.Failed),
            (JobStatus.Running, JobStatus.Canceled),
            (JobStatus.Failed, JobStatus.Ready),
            (JobStatus.Failed, JobStatus.Blocked),
            (JobStatus.Pending, JobStatus.Blocked),
            (JobStatus.Ready, JobStatus.Blocked),
        }.ToFrozenSet();
}
