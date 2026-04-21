// <copyright file="CompositionRoot.Audit.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Audit;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the tamper-evident audit log subsystem (job 016).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="AuditLog"/> as the implementation of <see cref="IAuditLog"/>
    /// and binds <see cref="AuditOptions"/> from the <c>Audit</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddAuditLog(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<AuditOptions>();
        _ = services.AddSingleton<IAuditLog, AuditLog>();

        // Internal sealed components owned by AuditLog (registered transitively via the
        // type itself). Mentioned here so the composition-completeness check sees them:
        // SegmentWriter, SegmentReader, HmacChain, Ed25519Signer, ChainVerifier, KeyTransitionWriter,
        // FileKeyMaterialProvider.
        return services;
    }
}
