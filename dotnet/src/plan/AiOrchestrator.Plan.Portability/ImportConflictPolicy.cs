// <copyright file="ImportConflictPolicy.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Portability;

/// <summary>How <see cref="PlanImporter"/> reacts when the archived plan id already exists in the store.</summary>
public enum ImportConflictPolicy
{
    /// <summary>Throw <see cref="ImportConflictException"/> on any collision.</summary>
    Reject = 0,

    /// <summary>Assign a freshly generated <see cref="AiOrchestrator.Models.Ids.PlanId"/> (default).</summary>
    GenerateNewId = 1,

    /// <summary>Replace only when the existing plan is in <see cref="AiOrchestrator.Plan.Models.PlanStatus.Archived"/> status; otherwise throw.</summary>
    OverwriteIfArchived = 2,
}
