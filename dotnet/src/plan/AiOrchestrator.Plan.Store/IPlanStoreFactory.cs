// <copyright file="IPlanStoreFactory.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Creates and caches <see cref="IPlanStore"/> instances scoped to a specific repository root.
/// This enables a single daemon process to serve multiple repositories concurrently.
/// </summary>
public interface IPlanStoreFactory
{
    /// <summary>
    /// Gets (or creates) an <see cref="IPlanStore"/> whose store root is derived from
    /// <paramref name="repoRoot"/> (e.g. <c>{repoRoot}/.orchestrator/plans</c>).
    /// Subsequent calls with the same <paramref name="repoRoot"/> return the same instance.
    /// </summary>
    /// <param name="repoRoot">Absolute path to the repository root directory.</param>
    /// <returns>A store scoped to the given repository.</returns>
    IPlanStore GetStore(string repoRoot);
}
