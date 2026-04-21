// <copyright file="ICredentialBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Abstractions.Credentials;

/// <summary>
/// Retrieves credentials for external services on behalf of an authenticated principal.
/// Implementations should cache credentials and refresh them before they expire.
/// </summary>
public interface ICredentialBroker
{
    /// <summary>Retrieves a credential for the given URL, scoped to the requesting principal.</summary>
    /// <param name="url">The service URL for which a credential is needed.</param>
    /// <param name="principal">The authenticated principal on whose behalf the credential is requested.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>
    /// A <see cref="Credential"/> for the URL. The caller must dispose it when finished
    /// to allow the broker to scrub the secret from memory.
    /// </returns>
    ValueTask<Credential> GetAsync(string url, AuthContext principal, CancellationToken ct);

    /// <summary>Invalidates any cached credential for the given URL so the next call to <see cref="GetAsync"/> fetches a fresh one.</summary>
    /// <param name="url">The service URL whose cached credential should be evicted.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the credential has been invalidated.</returns>
    ValueTask InvalidateAsync(string url, CancellationToken ct);
}
