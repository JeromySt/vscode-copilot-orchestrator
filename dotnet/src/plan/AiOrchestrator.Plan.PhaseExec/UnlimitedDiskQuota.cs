// <copyright file="UnlimitedDiskQuota.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Plan.PhaseExec;

/// <summary>A trivial in-memory <see cref="IDiskQuota"/> with an unlimited cap; suitable for default DI when no cap is configured.</summary>
public sealed class UnlimitedDiskQuota : IDiskQuota
{
    /// <inheritdoc/>
    public bool TryReserve(PlanId plan, long bytes) => true;

    /// <inheritdoc/>
    public void Release(PlanId plan, long bytes)
    {
    }
}
