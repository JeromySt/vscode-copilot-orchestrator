// <copyright file="IRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Concurrency.Broker.Rpc;

/// <summary>
/// Provides an IPC server endpoint for the broker daemon.
/// Implementations handle both path-based Unix domain sockets (Linux/macOS)
/// and named pipes (Windows).
/// </summary>
public interface IRpcServer : IAsyncDisposable
{
    /// <summary>Starts accepting client connections and handling RPC calls.</summary>
    /// <param name="ct">Cancellation token that stops the server when cancelled.</param>
    /// <returns>A task that completes when the server has started listening.</returns>
    Task StartAsync(CancellationToken ct);

    /// <summary>Gracefully stops the server, waiting for in-flight calls to complete.</summary>
    /// <param name="ct">Cancellation token for the stop operation.</param>
    /// <returns>A task that completes when the server has stopped.</returns>
    Task StopAsync(CancellationToken ct);
}
