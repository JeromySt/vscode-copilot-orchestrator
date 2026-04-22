// <copyright file="JobStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

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
