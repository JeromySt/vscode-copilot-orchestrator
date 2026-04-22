// <copyright file="CompositionRoot.Time.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Time;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the <c>AiOrchestrator.Time</c> layer.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the default time services:
    /// <see cref="SystemClock"/> wrapped in <see cref="MonotonicGuard"/> as <see cref="IClock"/>,
    /// and <see cref="SystemDelayProvider"/> as <see cref="IDelayProvider"/>.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <see cref="IServiceCollection"/> for chaining.</returns>
    public static IServiceCollection AddTime(this IServiceCollection services)
    {
        return services
            .AddSingleton<SystemClock>()
            .AddSingleton<IClock>(sp => new MonotonicGuard(
                sp.GetRequiredService<SystemClock>(),
                sp.GetRequiredService<ITelemetrySink>()))
            .AddSingleton<IDelayProvider, SystemDelayProvider>();
    }
}
