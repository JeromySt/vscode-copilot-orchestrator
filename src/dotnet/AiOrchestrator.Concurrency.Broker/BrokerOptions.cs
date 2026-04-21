// <copyright file="BrokerOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Concurrency.Broker;

/// <summary>Configuration options for the host concurrency broker.</summary>
public sealed record BrokerOptions
{
    /// <summary>
    /// Gets the path-based Unix domain socket path used on Linux/macOS.
    /// CONC-BROKER-2: must be a filesystem path, NOT an abstract socket.
    /// </summary>
    public AbsolutePath SocketPath { get; init; } = new AbsolutePath("/run/ai-orchestrator/coord.sock");

    /// <summary>Gets the Windows named-pipe name used on Windows.</summary>
    public string PipeName { get; init; } = @"\\.\pipe\AiOrchestratorCoord";

    /// <summary>Gets the maximum number of concurrent jobs across all users on this host. Default is 16.</summary>
    [Range(1, 1024)]
    public int MaxConcurrentHostWide { get; init; } = 16;

    /// <summary>Gets the fairness policy controlling how slots are distributed across principals.</summary>
    public HostFairness HostFairness { get; init; } = HostFairness.Proportional;

    /// <summary>Gets the TTL for a broker lease. Defaults to 5 minutes.</summary>
    public TimeSpan LeaseTtl { get; init; } = TimeSpan.FromMinutes(5);
}
