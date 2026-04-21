// <copyright file="Phase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models;

/// <summary>The execution phase of a job within the orchestration pipeline.</summary>
public enum Phase
{
    /// <summary>The setup phase prepares the execution environment.</summary>
    Setup,

    /// <summary>The prechecks phase validates preconditions before work begins.</summary>
    Prechecks,

    /// <summary>The work phase performs the actual job task.</summary>
    Work,

    /// <summary>The postchecks phase validates the results of the work phase.</summary>
    Postchecks,

    /// <summary>The commit phase persists the results of the job.</summary>
    Commit,

    /// <summary>The teardown phase cleans up resources after the job completes.</summary>
    Teardown,
}
