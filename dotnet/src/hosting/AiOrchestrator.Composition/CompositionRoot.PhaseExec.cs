// <copyright file="CompositionRoot.PhaseExec.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Plan.PhaseExec;
using AiOrchestrator.Plan.PhaseExec.Phases;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the <c>AiOrchestrator.Plan.PhaseExec</c> layer (job 031).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the phase-executor services:
    /// <list type="bullet">
    ///   <item><see cref="PhaseExecutor"/> as the singleton <see cref="IPhaseExecutor"/>.</item>
    ///   <item>The six per-phase runners (Setup/Prechecks/Work/Postchecks/Commit/ForwardIntegration).</item>
    ///   <item><see cref="UnlimitedDiskQuota"/> as the default <see cref="IDiskQuota"/>.</item>
    ///   <item>A <see cref="NullCommitInputs"/> placeholder (replace at hosting time).</item>
    /// </list>
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The same collection for chaining.</returns>
    public static IServiceCollection AddPhaseExec(this IServiceCollection services)
    {
        services.AddOptions<PhaseOptions>();

        services.AddSingleton<IDiskQuota, UnlimitedDiskQuota>();
        services.AddSingleton<ICommitInputs, NullCommitInputs>();

        services.AddSingleton<IPhaseRunner, SetupPhase>();
        services.AddSingleton<IPhaseRunner, PrechecksPhase>();
        services.AddSingleton<IPhaseRunner, WorkPhase>();
        services.AddSingleton<IPhaseRunner, PostchecksPhase>();
        services.AddSingleton<IPhaseRunner, CommitPhase>();
        services.AddSingleton<IPhaseRunner, ForwardIntegrationPhase>();

        services.AddSingleton<IPhaseExecutor, PhaseExecutor>();

        return services;
    }
}
