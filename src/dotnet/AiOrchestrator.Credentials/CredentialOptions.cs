// <copyright file="CredentialOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Credentials.Backoff;

namespace AiOrchestrator.Credentials;

/// <summary>
/// Configures the <see cref="CredentialBroker"/>: host allowlist, GCM binary / timeout,
/// and backoff policy for credential-invalidation events.
/// </summary>
public sealed record CredentialOptions
{
    /// <summary>
    /// Gets the allowed host suffixes for credential retrieval (CRED-ACL-1 / INV-1).
    /// A URL's host is matched using case-insensitive suffix match against this list;
    /// an exact host match is also accepted. Examples: <c>"github.com"</c>, <c>"dev.azure.com"</c>.
    /// </summary>
    public required ImmutableArray<string> AllowedHostSuffixes { get; init; }

    /// <summary>Gets the maximum wall-clock time allotted to a single GCM invocation. Defaults to 30 s (INV-6).</summary>
    public TimeSpan GcmTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Gets the name of the GCM executable; defaults to <c>git-credential-manager</c>.</summary>
    public string GcmExecutableName { get; init; } = "git-credential-manager";

    /// <summary>Gets the exponential-backoff policy engaged on repeated credential-invalidation events (INV-7 / CRED-INVAL-1).</summary>
    public CredentialBackoffOptions Backoff { get; init; } = new();
}
