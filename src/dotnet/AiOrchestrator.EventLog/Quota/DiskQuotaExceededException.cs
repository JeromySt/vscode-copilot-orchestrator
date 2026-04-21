// <copyright file="DiskQuotaExceededException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.EventLog.Quota;

/// <summary>
/// Thrown by <see cref="PerPlanDiskCap.TryReserve"/> consumers (DISK-PLAN-2) when a publish would
/// push a plan over its per-plan disk byte budget. Carries the offending plan ID and current usage
/// so callers can surface a structured failure to the publisher.
/// </summary>
public sealed class DiskQuotaExceededException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="DiskQuotaExceededException"/> class.</summary>
    /// <param name="planId">The plan whose quota was exceeded.</param>
    /// <param name="requested">The size in bytes of the publish that triggered the failure.</param>
    /// <param name="current">The plan's currently reserved byte total.</param>
    /// <param name="cap">The configured byte cap.</param>
    /// <param name="message">A human-readable description of the failure.</param>
    public DiskQuotaExceededException(PlanId planId, long requested, long current, long cap, string message)
        : base(message)
    {
        this.PlanId = planId;
        this.Requested = requested;
        this.Current = current;
        this.Cap = cap;
    }

    /// <summary>Gets the plan whose quota was exceeded.</summary>
    public PlanId PlanId { get; }

    /// <summary>Gets the size in bytes of the publish that triggered the failure.</summary>
    public long Requested { get; }

    /// <summary>Gets the plan's currently reserved byte total at the time of the failure.</summary>
    public long Current { get; }

    /// <summary>Gets the configured byte cap for the plan.</summary>
    public long Cap { get; }
}
