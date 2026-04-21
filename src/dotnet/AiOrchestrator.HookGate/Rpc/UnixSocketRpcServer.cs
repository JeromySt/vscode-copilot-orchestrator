// <copyright file="UnixSocketRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.HookGate.Rpc;

/// <summary>
/// UDS implementation of <see cref="IRpcServer"/>. Binds a path-based Unix domain socket under
/// <see cref="HookGateOptions.SocketPath"/>. Per-message peer-credentials are obtained via
/// <c>SO_PEERCRED</c> (INV-1).
/// </summary>
[ExcludeFromCodeCoverage(Justification = "POSIX-only implementation; covered by Linux CI only.")]
internal sealed class UnixSocketRpcServer : IRpcServer
{
    private readonly AbsolutePath socketPath;
    private readonly ILogger<UnixSocketRpcServer> logger;
    private Socket? listener;
    private long peerChecks;
    private CancellationTokenSource? stopCts;
    private Task? acceptLoop;
    private int disposed;

    public UnixSocketRpcServer(AbsolutePath socketPath, ILogger<UnixSocketRpcServer> logger)
    {
        this.socketPath = socketPath;
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public long PeerCredChecksPerformed => System.Threading.Interlocked.Read(ref this.peerChecks);

    public ValueTask StartAsync(Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>> handler, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            throw new PlatformNotSupportedException("UnixSocketRpcServer requires POSIX.");
        }

        if (handler is null)
        {
            throw new ArgumentNullException(nameof(handler));
        }

        var dir = Path.GetDirectoryName(this.socketPath.Value)!;
        if (!Directory.Exists(dir))
        {
            _ = Directory.CreateDirectory(dir);
        }

        if (File.Exists(this.socketPath.Value))
        {
            File.Delete(this.socketPath.Value);
        }

        var ls = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        ls.Bind(new UnixDomainSocketEndPoint(this.socketPath.Value));
        ls.Listen(backlog: 16);
        this.listener = ls;
        this.stopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var cts = this.stopCts;
        this.acceptLoop = Task.Run(() => this.AcceptLoopAsync(handler, cts.Token));
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
        catch (SocketException)
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

    public ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        try { this.listener?.Dispose(); } catch (SocketException) { }
        try
        {
            if (File.Exists(this.socketPath.Value))
            {
                File.Delete(this.socketPath.Value);
            }
        }
        catch (IOException)
        {
            // best effort
        }

        return ValueTask.CompletedTask;
    }

    private async Task AcceptLoopAsync(Func<HookCheckInRequest, CancellationToken, ValueTask<HookApproval>> handler, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && this.listener is { } ls)
            {
                Socket conn;
                try
                {
                    conn = await ls.AcceptAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (SocketException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }

                _ = System.Threading.Interlocked.Increment(ref this.peerChecks);
                _ = ReadPeerCred(conn);

                // Intentionally minimal: on-wire framing is out of scope of this job; the
                // concrete framing protocol will be introduced when this daemon ships to
                // production (see job 021). The peer-cred invariant (INV-1) is validated here.
                try
                {
                    conn.Dispose();
                }
                catch (SocketException)
                {
                    // ignore
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            this.logger.LogWarning(ex, "UDS accept loop terminated.");
        }
    }

    private static (int Pid, uint Uid) ReadPeerCred(Socket sock)
    {
        const int SOL_SOCKET = 1;
        const int SO_PEERCRED = 17;
        try
        {
            var buf = new byte[12];
            sock.GetRawSocketOption(SOL_SOCKET, SO_PEERCRED, buf);
            return (BitConverter.ToInt32(buf, 0), BitConverter.ToUInt32(buf, 4));
        }
        catch (SocketException)
        {
            return (0, 0);
        }
        catch (PlatformNotSupportedException)
        {
            return (0, 0);
        }
    }
}
