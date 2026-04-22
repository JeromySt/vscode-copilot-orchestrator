// <copyright file="BrokerUnavailableException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Concurrency.Broker.Exceptions;

/// <summary>
/// Thrown when the host concurrency broker daemon is not reachable.
/// The client falls back to per-user-only limiting per INV-9.
/// </summary>
public sealed class BrokerUnavailableException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BrokerUnavailableException"/> class.
    /// </summary>
    /// <param name="socketPath">The socket path that could not be connected to.</param>
    /// <param name="innerException">The underlying connection exception, if any.</param>
    [System.Diagnostics.CodeAnalysis.SetsRequiredMembers]
    public BrokerUnavailableException(AbsolutePath socketPath, Exception? innerException = null)
        : base($"Host concurrency broker unavailable at '{socketPath}'.", innerException)
    {
        this.SocketPath = socketPath;
    }

    /// <summary>Gets the socket path the client attempted to connect to.</summary>
    public required AbsolutePath SocketPath { get; init; }
}
