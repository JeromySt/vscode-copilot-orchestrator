// <copyright file="HostFairness.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>Controls how the host-wide concurrency broker distributes slots across principals.</summary>
public enum HostFairness
{
    /// <summary>
    /// Divides the active slot pool roughly proportionally to the number of active principals.
    /// Each principal receives approximately the same share of the host-wide capacity.
    /// </summary>
    Proportional,

    /// <summary>
    /// Admits requests in a deterministic round-robin cycle across principals.
    /// Within a single principal, requests are admitted in FIFO order.
    /// </summary>
    StrictRoundRobin,
}
