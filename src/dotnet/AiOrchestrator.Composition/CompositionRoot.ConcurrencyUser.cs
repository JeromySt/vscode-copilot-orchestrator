// <copyright file="CompositionRoot.ConcurrencyUser.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Concurrency.User;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the <c>AiOrchestrator.Concurrency.User</c> layer.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the per-user concurrency services:
    /// <see cref="PerUserConcurrencyLimiter"/> as <see cref="IPerUserConcurrency"/>.
    /// <see cref="UserAdmission"/> is a disposable value returned by
    /// <see cref="IPerUserConcurrency.AcquireAsync"/> — it is not a DI service.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <see cref="IServiceCollection"/> for chaining.</returns>
    public static IServiceCollection AddPerUserConcurrency(this IServiceCollection services)
    {
        return services
            .AddOptions<UserConcurrencyOptions>()
            .Services
            .AddSingleton<IPerUserConcurrency>(sp => new PerUserConcurrencyLimiter(
                sp.GetRequiredService<IClock>(),
                sp.GetRequiredService<IEventBus>(),
                sp.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<UserConcurrencyOptions>>()));
    }
}
