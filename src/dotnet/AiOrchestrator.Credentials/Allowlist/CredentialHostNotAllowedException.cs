// <copyright file="CredentialHostNotAllowedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Credentials.Allowlist;

/// <summary>
/// Thrown when a credential is requested for a URL whose host is not in
/// <see cref="CredentialOptions.AllowedHostSuffixes"/> (INV-1 / CRED-ACL-1).
/// </summary>
public sealed class CredentialHostNotAllowedException : Exception
{
    /// <summary>Initializes a new <see cref="CredentialHostNotAllowedException"/>.</summary>
    /// <param name="url">The rejected URL.</param>
    /// <param name="allowedSuffixes">The configured allowlist at the time of rejection.</param>
    public CredentialHostNotAllowedException(Uri url, ImmutableArray<string> allowedSuffixes)
        : base($"Host '{url?.Host}' is not in the credential host allowlist.")
    {
        this.Url = url ?? throw new ArgumentNullException(nameof(url));
        this.AllowedSuffixes = allowedSuffixes;
    }

    /// <summary>Gets the URL that was rejected.</summary>
    public Uri Url { get; }

    /// <summary>Gets the host-suffix allowlist at the time of rejection.</summary>
    public ImmutableArray<string> AllowedSuffixes { get; }
}
