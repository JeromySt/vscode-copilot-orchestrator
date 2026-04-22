// <copyright file="NamedPipeRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO.Pipes;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.HookGate.Rpc;

/// <summary>
/// Windows named-pipe implementation of <see cref="IRpcServer"/>. Peer-credentials come from
/// <c>ImpersonateNamedPipeClient</c> on each inbound connection (INV-1).
/// </summary>
internal sealed class NamedPipeRpcServer : IRpcServer
{
    private readonly string pipeName;
    private readonly ILogger<NamedPipeRpcServer> logger;
    private long peerChecks;
    private CancellationTokenSource? stopCts;
    private Task? acceptLoop;
    private NamedPipeServerStream? listener;
    private int disposed;

    public NamedPipeRpcServer(string pipeName, ILogger<NamedPipeRpcServer> logger)
    {
        this.pipeName = pipeName ?? throw new ArgumentNullException(nameof(pipeName));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public long PeerCredChecksPerformed => System.Threading.Interlocked.Read(ref this.peerChecks);

    public ValueTask StartAsync(Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>> handler, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (handler is null)
        {
            throw new ArgumentNullException(nameof(handler));
        }

        var name = this.pipeName.StartsWith(@"\\.\pipe\", StringComparison.Ordinal)
            ? this.pipeName[@"\\.\pipe\".Length..]
            : this.pipeName;

        this.listener = new NamedPipeServerStream(
            name,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

        this.stopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var cts = this.stopCts;
        this.acceptLoop = Task.Run(() => this.AcceptLoopAsync(cts.Token));
        return ValueTask.CompletedTask;
    }

    public async ValueTask StopAsync(CancellationToken ct)
    {
        var cts = this.stopCts;
        if (cts is not null)
        {
            await cts.CancelAsync().ConfigureAwait(false);
        }

        try
        {
            this.listener?.Dispose();
        }
        catch (IOException)
        {
            // best effort
        }

        if (this.acceptLoop is { } loop)
        {
            try
            {
                await loop.WaitAsync(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                // best effort
            }
            catch (OperationCanceledException)
            {
                // best effort
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        if (this.listener is not null)
        {
            await this.listener.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && this.listener is { } ls)
            {
                try
                {
                    await ls.WaitForConnectionAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (IOException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }

                _ = System.Threading.Interlocked.Increment(ref this.peerChecks);
                try
                {
                    ls.Disconnect();
                }
                catch (IOException)
                {
                    // ignore
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            this.logger.LogWarning(ex, "named-pipe accept loop terminated.");
        }
    }
}
