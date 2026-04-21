// <copyright file="HostAdmissionExpired.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Concurrency.Broker.Events;

/// <summary>
/// Published when a host-level lease expires because the TTL elapsed before the client
/// explicitly released it.
/// </summary>
public sealed class HostAdmissionExpired
{
    /// <summary>Gets the principal whose lease expired.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the job whose lease expired.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets the broker lease identifier that expired.</summary>
    public required string BrokerLeaseId { get; init; }

    /// <summary>Gets the UTC timestamp when the lease expired.</summary>
    public required DateTimeOffset ExpiredAt { get; init; }
}
