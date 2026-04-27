// <copyright file="IPlanMigrator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Plan.Store.Migration;

/// <summary>
/// Migrates legacy TS-format plans (<c>plan.json</c>) to the .NET checkpoint format
/// (<c>checkpoint.json</c> + <c>journal.ndjson</c>).
/// </summary>
public interface IPlanMigrator
{
    /// <summary>
    /// Scans for legacy TS-format plans and migrates them to the .NET format.
    /// Called once when a PlanStore is first accessed for a given repo root.
    /// Returns the number of plans migrated.
    /// </summary>
    /// <param name="planStoreRoot">The root directory containing plan subdirectories.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The number of plans successfully migrated.</returns>
    ValueTask<int> MigrateIfNeededAsync(AbsolutePath planStoreRoot, CancellationToken ct);
}
