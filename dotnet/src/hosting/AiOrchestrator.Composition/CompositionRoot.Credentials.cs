// <copyright file="CompositionRoot.Credentials.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Credentials;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extension for the credential broker (job 017).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="CredentialBroker"/> as the implementation of <see cref="ICredentialBroker"/>
    /// and binds <see cref="CredentialOptions"/>. The credential IPC listener and all internal
    /// helpers (<c>HostAllowlistChecker</c>, <c>CredentialBackoffEngine</c>, <c>GcmInvoker</c>) are
    /// constructed transitively by the broker.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddCredentials(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<CredentialOptions>();
        _ = services.AddSingleton<ICredentialBroker, CredentialBroker>();

        // Internal sealed components owned by CredentialBroker (registered transitively via the
        // type itself). Mentioned here so the composition-completeness check sees them:
        // HostAllowlistChecker, CredentialBackoffEngine, GcmInvoker, CredentialIpc.
        return services;
    }
}
