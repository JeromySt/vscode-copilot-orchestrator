// <copyright file="PlanStatus.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Models;

/// <summary>Lifecycle status of a plan.</summary>
public enum PlanStatus
{
    /// <summary>Plan has been created and is waiting to start.</summary>
    Pending = 0,

    /// <summary>Plan is actively executing jobs.</summary>
    Running = 1,

    /// <summary>Plan execution has been paused.</summary>
    Paused = 2,

    /// <summary>All jobs completed successfully.</summary>
    Succeeded = 3,

    /// <summary>Some jobs failed but others succeeded.</summary>
    Partial = 4,

    /// <summary>Plan was canceled before completion.</summary>
    Canceled = 5,

    /// <summary>Plan failed due to errors.</summary>
    Failed = 6,

    /// <summary>Plan has been archived (terminal, read-only, opt-in for portability overwrite).</summary>
    Archived = 7,
}
