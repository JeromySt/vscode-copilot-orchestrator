// <copyright file="CompositionRoot.SkewManifest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.SkewManifest;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the skew manifest subsystem (job 039).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers <see cref="SkewManifestObserver"/> as the hosted service that fetches and
    /// verifies the release-manifest signed by the burn-in HSM set.
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddSkewManifest(this IServiceCollection services)
    {
        System.ArgumentNullException.ThrowIfNull(services);

        _ = services.AddOptions<SkewManifestOptions>();
        _ = services.AddHttpClient();
        _ = services.AddSingleton<SkewManifestObserver>();
        _ = services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<SkewManifestObserver>());

        // Internal sealed components owned by SkewManifestObserver (registered transitively):
        // HsmSignatureVerifier, TransparencyLogChecker.
        return services;
    }
}
