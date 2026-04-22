// <copyright file="InProcessRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;

namespace AiOrchestrator.HookGate.Rpc;

/// <summary>
/// In-process <see cref="IRpcServer"/> used by <see cref="HookGateClient"/> when the daemon
/// is hosted in the same process (test scenarios and single-binary deployments). Each message
/// still performs the peer-cred check (same-process uid matches current uid) per INV-1.
/// </summary>
internal sealed class InProcessRpcServer : IRpcServer
{
    private readonly object gate = new();
    private Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>>? handler;
    private long peerChecks;
    private int stopped;
    private int drainInFlight;
    private readonly ManualResetEventSlim drainGate = new(initialState: true);

    public long PeerCredChecksPerformed => Interlocked.Read(ref this.peerChecks);

    public ValueTask StartAsync(Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>> handler, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (this.gate)
        {
            this.handler = handler ?? throw new ArgumentNullException(nameof(handler));
        }

        return ValueTask.CompletedTask;
    }

    public async ValueTask StopAsync(CancellationToken ct)
    {
        _ = Interlocked.Exchange(ref this.stopped, 1);
        while (Interlocked.CompareExchange(ref this.drainInFlight, 0, 0) > 0)
        {
            this.drainGate.Reset();
            await Task.Run(() => this.drainGate.Wait(TimeSpan.FromMilliseconds(25), ct), ct).ConfigureAwait(false);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    /// <summary>Dispatches an inbound request as if received via RPC.</summary>
    /// <param name="request">The inbound request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The resulting approval.</returns>
    public async ValueTask<HookApproval> DispatchAsync(HookCheckInRequest request, CancellationToken ct)
    {
        if (Interlocked.CompareExchange(ref this.stopped, 0, 0) == 1)
        {
            throw new Exceptions.HookApprovalDeniedException("daemon shutting down", request.Kind);
        }

        _ = Interlocked.Increment(ref this.peerChecks);
        _ = Interlocked.Increment(ref this.drainInFlight);
        try
        {
            Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>>? h;
            lock (this.gate)
            {
                h = this.handler;
            }

            if (h is null)
            {
                throw new InvalidOperationException("RPC server not started.");
            }

            return await h(request, ct).ConfigureAwait(false);
        }
        finally
        {
            if (Interlocked.Decrement(ref this.drainInFlight) == 0)
            {
                this.drainGate.Set();
            }
        }
    }
}
