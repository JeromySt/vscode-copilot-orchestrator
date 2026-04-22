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

    /// <summary>Job is currently executing.</summary>
    Running = 2,

    /// <summary>Job completed successfully.</summary>
    Succeeded = 3,

    /// <summary>Job failed during execution.</summary>
    Failed = 4,

    /// <summary>Job was canceled.</summary>
    Canceled = 5,

    /// <summary>Job was skipped due to plan-level decisions.</summary>
    Skipped = 6,
}
