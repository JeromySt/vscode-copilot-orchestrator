// <copyright file="PerPlanDiskCap.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.EventLog.Quota;

/// <summary>
/// Tracks per-plan reserved byte totals against a fixed cap (DISK-PLAN-1).
/// Reservations are expected to be made before a write and released after a delete or compaction.
/// </summary>
internal sealed class PerPlanDiskCap
{
    private readonly long maxBytesPerPlan;
    private readonly ConcurrentDictionary<PlanId, long> reserved = new();

    /// <summary>Initializes a new instance of the <see cref="PerPlanDiskCap"/> class.</summary>
    /// <param name="maxBytesPerPlan">The byte cap applied per plan; must be positive.</param>
    public PerPlanDiskCap(long maxBytesPerPlan)
    {
        if (maxBytesPerPlan <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytesPerPlan));
        }

        this.maxBytesPerPlan = maxBytesPerPlan;
    }

    /// <summary>Gets the configured cap value (used when constructing exceptions).</summary>
    public long Cap => this.maxBytesPerPlan;

    /// <summary>Atomically reserves <paramref name="bytes"/> for <paramref name="plan"/>.</summary>
    /// <param name="plan">The plan being charged.</param>
    /// <param name="bytes">The byte cost to reserve; non-positive values succeed without effect.</param>
    /// <returns><see langword="true"/> if the reservation fit under the cap; otherwise <see langword="false"/>.</returns>
    public bool TryReserve(PlanId plan, long bytes)
    {
        if (bytes <= 0)
        {
            return true;
        }

        while (true)
        {
            var current = this.reserved.GetValueOrDefault(plan);
            var next = current + bytes;
            if (next > this.maxBytesPerPlan)
            {
                return false;
            }

            if (this.reserved.TryGetValue(plan, out var actual))
            {
                if (actual != current)
                {
                    continue;
                }

                if (this.reserved.TryUpdate(plan, next, current))
                {
                    return true;
                }
            }
            else
            {
                if (this.reserved.TryAdd(plan, next))
                {
                    return true;
                }
            }
        }
    }

    /// <summary>Releases <paramref name="bytes"/> previously reserved for <paramref name="plan"/>.</summary>
    /// <param name="plan">The plan to credit.</param>
    /// <param name="bytes">The byte amount to release; non-positive values are ignored.</param>
    public void Release(PlanId plan, long bytes)
    {
        if (bytes <= 0)
        {
            return;
        }

        while (true)
        {
            if (!this.reserved.TryGetValue(plan, out var current))
            {
                return;
            }

            var next = Math.Max(0, current - bytes);
            if (this.reserved.TryUpdate(plan, next, current))
            {
                return;
            }
        }
    }

    /// <summary>Gets the bytes currently reserved against the given plan.</summary>
    /// <param name="plan">The plan to inspect.</param>
    /// <returns>The reserved byte total, or 0 if none.</returns>
    public long Current(PlanId plan) => this.reserved.GetValueOrDefault(plan);

    /// <summary>Builds a <see cref="DiskQuotaExceededException"/> for a failed reservation.</summary>
    /// <param name="plan">The plan whose reservation failed.</param>
    /// <param name="requested">The byte amount that was attempted.</param>
    /// <param name="current">The currently reserved byte total observed at the time of the failure.</param>
    /// <param name="cap">The cap value to attribute in the exception.</param>
    /// <returns>A populated exception for the caller to throw.</returns>
    public DiskQuotaExceededException CreateException(PlanId plan, long requested, long current, long cap)
        => new(
            plan,
            requested,
            current,
            cap,
            $"DiskQuotaExceeded {{ planId={plan}, requested={requested}, current={current}, cap={cap} }}");
}
