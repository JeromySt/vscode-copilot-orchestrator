// <copyright file="UnixSocketTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Transports;

/// <summary>
/// Unix-domain-socket-backed MCP transport. Wraps a connected <see cref="NetworkStream"/>
/// with the same <c>Content-Length</c> framing used by <see cref="StdioTransport"/>.
/// </summary>
internal sealed class UnixSocketTransport : IMcpTransport, IDisposable
{
    private readonly StdioTransport inner;
    private readonly NetworkStream stream;
    private readonly Socket socket;

    public UnixSocketTransport(Socket connectedSocket)
    {
        ArgumentNullException.ThrowIfNull(connectedSocket);

        this.socket = connectedSocket;
        this.stream = new NetworkStream(connectedSocket, ownsSocket: false);
        this.inner = new StdioTransport(this.stream, this.stream, ownsStreams: false);
    }

    public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) => this.inner.ReceiveAsync(ct);

    public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) => this.inner.SendAsync(envelope, ct);

    public void Dispose()
    {
        this.inner.Dispose();
        this.stream.Dispose();
        this.socket.Dispose();
    }
}
