// <copyright file="JobStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Frozen;

namespace AiOrchestrator.Models;

/// <summary>The lifecycle status of a job.</summary>
public enum JobStatus
{
    /// <summary>The job has been created but is not yet ready to run.</summary>
    Pending,

    /// <summary>The job's dependencies have been satisfied and it is ready to be scheduled.</summary>
    Ready,

    /// <summary>The job has been assigned to a runner but has not yet started.</summary>
    Scheduled,

    /// <summary>The job is actively executing.</summary>
    Running,

    /// <summary>The job completed successfully.</summary>
    Succeeded,

    /// <summary>The job encountered a non-recoverable error.</summary>
    Failed,

    /// <summary>The job cannot proceed because a dependency failed.</summary>
    Blocked,

    /// <summary>The job was canceled before it could complete.</summary>
    Canceled,
}

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
