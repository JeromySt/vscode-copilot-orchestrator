// <copyright file="IRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Rpc;

/// <summary>
/// RPC transport for the hook-gate daemon. Accepts inbound check-in requests from peer
/// processes, enforces per-message peer-credential validation (INV-1), and dispatches the
/// request to the daemon-provided handler.
/// </summary>
public interface IRpcServer : IAsyncDisposable
{
    /// <summary>Gets the running count of peer-credential checks performed since start (INV-1).</summary>
    long PeerCredChecksPerformed { get; }

    /// <summary>Starts accepting inbound messages.</summary>
    /// <param name="handler">
    /// Callback invoked for each authenticated request; the daemon's approval issuer.
    /// Returning <see langword="null"/> signals denial.
    /// </param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes once the server is ready to accept messages.</returns>
    ValueTask StartAsync(Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>> handler, CancellationToken ct);

    /// <summary>Stops the listener; drains in-flight connections (INV-9).</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when all in-flight messages have been handled.</returns>
    ValueTask StopAsync(CancellationToken ct);
}
