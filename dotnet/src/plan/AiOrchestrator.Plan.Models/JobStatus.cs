// <copyright file="JobStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Models;

/// <summary>Lifecycle status of an individual job node.</summary>
public enum JobStatus
{
    /// <summary>Job is waiting for dependencies to complete.</summary>
    Pending = 0,

    /// <summary>All dependencies are satisfied; job is ready to execute.</summary>
    Ready = 1,

    /// <summary>Job has been assigned to a runner but has not yet started.</summary>
    Scheduled = 2,

    /// <summary>Job is currently executing.</summary>
    Running = 3,

    /// <summary>Job completed but its output is being split across dependents.</summary>
    CompletedSplit = 4,

    /// <summary>Job completed successfully.</summary>
    Succeeded = 5,

    /// <summary>Job failed during execution.</summary>
    Failed = 6,

    /// <summary>Job cannot proceed because a dependency failed.</summary>
    Blocked = 7,

    /// <summary>Job was canceled.</summary>
    Canceled = 8,

    /// <summary>Job was skipped due to plan-level decisions.</summary>
    Skipped = 9,
}
