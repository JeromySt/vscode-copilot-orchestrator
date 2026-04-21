// <copyright file="IDiskQuota.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>
/// Public abstraction over the per-plan disk quota tracker (DISK-PLAN-1).
/// The Commit phase reserves bytes here BEFORE writing; failure aborts the commit (INV-6).
/// In production this is wired to the EventLog's <c>PerPlanDiskCap</c> via the composition root.
/// </summary>
public interface IDiskQuota
{
    /// <summary>Atomically reserves <paramref name="bytes"/> for <paramref name="plan"/>.</summary>
    /// <param name="plan">The plan being charged.</param>
    /// <param name="bytes">The byte cost to reserve; non-positive values succeed without effect.</param>
    /// <returns><see langword="true"/> if the reservation fit under the cap; otherwise <see langword="false"/>.</returns>
    bool TryReserve(PlanId plan, long bytes);

    /// <summary>Releases <paramref name="bytes"/> previously reserved for <paramref name="plan"/>.</summary>
    /// <param name="plan">The plan to credit.</param>
    /// <param name="bytes">The byte amount to release; non-positive values are ignored.</param>
    void Release(PlanId plan, long bytes);
}
