// <copyright file="DiskQuotaExceededException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>Thrown when a Commit phase reservation exceeds the per-plan disk cap (INV-6).</summary>
[Serializable]
public sealed class DiskQuotaExceededException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="DiskQuotaExceededException"/> class.</summary>
    /// <param name="plan">The plan whose reservation failed.</param>
    /// <param name="requested">The byte amount that was attempted.</param>
    /// <param name="message">Human-readable description.</param>
    public DiskQuotaExceededException(PlanId plan, long requested, string message)
        : base(message)
    {
        this.Plan = plan;
        this.Requested = requested;
    }

    /// <summary>Gets the plan whose reservation failed.</summary>
    public PlanId Plan { get; }

    /// <summary>Gets the byte amount that was attempted.</summary>
    public long Requested { get; }
}
