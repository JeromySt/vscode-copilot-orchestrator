// <copyright file="CompositionRoot.WorktreeLease.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.WorktreeLease;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the <c>AiOrchestrator.WorktreeLease</c> module (job 019).</summary>
public static partial class CompositionRoot
{
    /// <summary>Registers <see cref="IWorktreeLease"/> backed by <see cref="WorktreeLeaseManager"/>.</summary>
    /// <param name="services">The DI service collection.</param>
    /// <returns>The same <paramref name="services"/> for chaining.</returns>
    /// <remarks>
    /// <see cref="LeaseHandle"/> is produced by <see cref="WorktreeLeaseManager.AcquireAsync"/>
    /// and is not itself a DI-resolvable service.
    /// </remarks>
    public static IServiceCollection AddWorktreeLease(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        _ = services.AddOptions<LeaseOptions>();
        _ = services.AddSingleton<WorktreeLeaseManager>();
        _ = services.AddSingleton<IWorktreeLease>(static sp => sp.GetRequiredService<WorktreeLeaseManager>());

        // LeaseHandle is a unit-of-work type — produced by the manager, not resolved from DI.
        // StaleLeaseDetector is started on demand per-worktree; registered as transient so callers
        // can new one up through the DI factory when they acquire a lease.
        _ = services.AddTransient<AiOrchestrator.WorktreeLease.Detection.StaleLeaseDetector>();
        return services;
    }
}
