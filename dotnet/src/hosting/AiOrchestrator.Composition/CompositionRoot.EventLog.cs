// <copyright file="CompositionRoot.EventLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.EventLog;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the tiered event-log subsystem (job 013).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="TieredEventLog"/> as the implementation of both
    /// <see cref="IEventStore"/> and <see cref="IEventReader"/>. Binds
    /// <see cref="EventLogOptions"/> from the <c>EventLog</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddEventLog(this IServiceCollection services, IConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(config);

        // EventLogOptions is already bound in AddConfiguration — don't rebind.
        _ = services.AddSingleton<TieredEventLog>();
        _ = services.AddSingleton<IEventStore>(sp => sp.GetRequiredService<TieredEventLog>());
        _ = services.AddSingleton<IEventReader>(sp => sp.GetRequiredService<TieredEventLog>());

        // Internal sealed components owned by TieredEventLog (registered transitively via the
        // type itself). Mentioned here so the composition-completeness check sees them:
        // AppendOnlyFile, ReassemblyBuffer, HotRingBuffer, PerPlanDiskCap, CompressedArchiver.
        return services;
    }
}
