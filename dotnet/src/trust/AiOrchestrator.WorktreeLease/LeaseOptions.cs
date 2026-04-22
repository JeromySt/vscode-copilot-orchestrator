// <copyright file="LeaseOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.WorktreeLease;

/// <summary>Tunable options for <see cref="WorktreeLeaseManager"/>.</summary>
public sealed record LeaseOptions
{
    /// <summary>Gets the interval at which <see cref="Detection.StaleLeaseDetector"/> polls the lease file.</summary>
    public TimeSpan StaleCheckInterval { get; init; } = TimeSpan.FromSeconds(10);

    /// <summary>Gets the overall timeout for a single <c>AcquireAsync</c> attempt (LS-CAS-2).</summary>
    public TimeSpan AcquireTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Gets the delay between acquire retries while waiting for contention to clear (LS-CAS-2).</summary>
    public TimeSpan AcquireRetryDelay { get; init; } = TimeSpan.FromMilliseconds(250);
}
