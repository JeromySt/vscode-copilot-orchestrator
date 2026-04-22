// <copyright file="CredentialBackoffOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Credentials.Backoff;

/// <summary>
/// Exponential-backoff parameters for credential invalidation (CRED-INVAL-1 v1.4):
/// after <see cref="FailuresBeforeBackoff"/> consecutive failures for a URL,
/// the effective delay grows as <c>InitialDelay * Multiplier^n</c>, capped at <see cref="MaxDelay"/>.
/// </summary>
public sealed record CredentialBackoffOptions
{
    /// <summary>Gets the number of consecutive failures before backoff engages. Default <c>5</c>.</summary>
    public int FailuresBeforeBackoff { get; init; } = 5;

    /// <summary>Gets the initial delay once backoff engages. Default 1 minute.</summary>
    public TimeSpan InitialDelay { get; init; } = TimeSpan.FromMinutes(1);

    /// <summary>Gets the upper bound on the effective delay. Default 1 hour.</summary>
    public TimeSpan MaxDelay { get; init; } = TimeSpan.FromHours(1);

    /// <summary>Gets the exponential-growth multiplier applied each additional failure. Default <c>2.0</c>.</summary>
    public double Multiplier { get; init; } = 2.0;
}
