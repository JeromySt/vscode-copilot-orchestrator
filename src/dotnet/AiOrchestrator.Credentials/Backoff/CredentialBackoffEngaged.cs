// <copyright file="CredentialBackoffEngaged.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Credentials.Backoff;

/// <summary>
/// Published once per backoff entry when the broker transitions a URL into the back-off state
/// (INV-8 / CRED-INVAL-2). Consumers may listen via <c>IEventBus</c>.
/// </summary>
public sealed class CredentialBackoffEngaged
{
    /// <summary>Gets the repository URL that entered the back-off state.</summary>
    public required Uri RepoUrl { get; init; }

    /// <summary>Gets the number of consecutive failures that triggered back-off.</summary>
    public required int FailureCount { get; init; }

    /// <summary>Gets the effective back-off delay applied on the current entry.</summary>
    public required TimeSpan EffectiveDelay { get; init; }

    /// <summary>Gets the UTC wall-clock time at which back-off engaged.</summary>
    public required DateTimeOffset At { get; init; }
}
