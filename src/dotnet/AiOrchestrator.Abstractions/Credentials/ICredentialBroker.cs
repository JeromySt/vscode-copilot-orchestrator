// <copyright file="ICredentialBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Abstractions.Credentials;

/// <summary>
/// Brokers OS-keychain access for git via Git Credential Manager (GCM), per §3.6 + §3.31.1.1.
/// Every <see cref="GetAsync"/> call is expected to be paired with either <see cref="StoreAsync"/>
/// (on successful use) or <see cref="EraseAsync"/> (on authentication failure) to complete the
/// <c>git credential</c> verb sequence (INV-5 / CRED-VERB-1).
/// </summary>
public interface ICredentialBroker
{
    /// <summary>Retrieves a credential for the given repository URL, scoped to the requesting principal.</summary>
    /// <param name="repoUrl">The repository URL for which a credential is needed.</param>
    /// <param name="principal">The authenticated principal on whose behalf the credential is requested.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="Credential"/> for the URL. Dispose when done to scrub the secret from memory.</returns>
    ValueTask<Credential> GetAsync(Uri repoUrl, AuthContext principal, CancellationToken ct);

    /// <summary>Stores (approves) the given credential as valid, completing the <c>git credential</c> verb sequence on success.</summary>
    /// <param name="repoUrl">The repository URL the credential was used with.</param>
    /// <param name="credential">The credential that was successfully used.</param>
    /// <param name="principal">The authenticated principal.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the store has been acknowledged.</returns>
    ValueTask StoreAsync(Uri repoUrl, Credential credential, AuthContext principal, CancellationToken ct);

    /// <summary>Erases (rejects) any cached credential for the URL, completing the <c>git credential</c> verb sequence on authentication failure.</summary>
    /// <param name="repoUrl">The repository URL whose credential should be erased.</param>
    /// <param name="principal">The authenticated principal.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the erase has been acknowledged.</returns>
    ValueTask EraseAsync(Uri repoUrl, AuthContext principal, CancellationToken ct);
}
