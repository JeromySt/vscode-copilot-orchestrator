// <copyright file="PlanStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Models;

/// <summary>Lifecycle status of a plan.</summary>
public enum PlanStatus
{
    /// <summary>Plan is being built by the scaffolder (jobs still being added).</summary>
    Scaffolding = 0,

    /// <summary>Plan has been created and is waiting to start.</summary>
    Pending = 1,

    /// <summary>Plan has been scaffolded and is waiting for the user to start it.</summary>
    PendingStart = 2,

    /// <summary>Plan is actively executing jobs.</summary>
    Running = 3,

    /// <summary>Pause has been requested; running jobs are finishing.</summary>
    Pausing = 4,

    /// <summary>Plan execution has been paused.</summary>
    Paused = 5,

    /// <summary>Plan has just been resumed; scheduler is re-evaluating.</summary>
    Resumed = 6,

    /// <summary>All jobs completed successfully.</summary>
    Succeeded = 7,

    /// <summary>Some jobs failed but others succeeded.</summary>
    Partial = 8,

    /// <summary>Plan was canceled before completion.</summary>
    Canceled = 9,

    /// <summary>Plan failed due to errors.</summary>
    Failed = 10,

    /// <summary>Plan has been archived (terminal, read-only, opt-in for portability overwrite).</summary>
    Archived = 11,
}
