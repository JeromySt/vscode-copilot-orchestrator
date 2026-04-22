// <copyright file="NamedPipeTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Transports;

/// <summary>
/// Named-pipe-backed MCP transport. Wraps a connected <see cref="PipeStream"/> with the
/// same <c>Content-Length</c> framing used by <see cref="StdioTransport"/>.
/// </summary>
internal sealed class NamedPipeTransport : IMcpTransport, IDisposable
{
    private readonly StdioTransport inner;
    private readonly PipeStream pipe;

    public NamedPipeTransport(PipeStream pipe)
    {
        ArgumentNullException.ThrowIfNull(pipe);

        this.pipe = pipe;
        this.inner = new StdioTransport(pipe, pipe, ownsStreams: false);
    }

    public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) => this.inner.ReceiveAsync(ct);

    public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) => this.inner.SendAsync(envelope, ct);

    public void Dispose()
    {
        this.inner.Dispose();
        this.pipe.Dispose();
    }
}
