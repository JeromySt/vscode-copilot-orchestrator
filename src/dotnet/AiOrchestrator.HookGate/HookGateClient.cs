// <copyright file="HookGateClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.HookGate.Rpc;

namespace AiOrchestrator.HookGate;

/// <summary>
/// Default <see cref="IHookGateClient"/>. Dispatches check-in requests through the
/// <see cref="IRpcServer"/>; when the daemon is hosted in the same process, the in-process
/// RPC server short-circuits to the daemon's handler.
/// </summary>
public sealed class HookGateClient : IHookGateClient
{
    private readonly HookGateDaemon daemon;

    /// <summary>Initializes a new <see cref="HookGateClient"/>.</summary>
    /// <param name="daemon">The hosted daemon instance.</param>
    public HookGateClient(HookGateDaemon daemon)
        => this.daemon = daemon ?? throw new ArgumentNullException(nameof(daemon));

    /// <inheritdoc/>
    public ValueTask<HookApproval> CheckInAsync(HookCheckInRequest request, CancellationToken ct)
        => this.daemon.HandleCheckInAsync(request, ct);
}
