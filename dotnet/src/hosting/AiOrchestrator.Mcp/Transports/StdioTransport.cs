// <copyright file="StdioTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Mcp.Transports;

/// <summary>
/// MCP stdio transport. Reads and writes <c>Content-Length</c>-framed JSON-RPC messages
/// per the MCP specification: each message is preceded by an HTTP-style header block
/// terminated by <c>\r\n\r\n</c> containing at least a <c>Content-Length</c> entry.
/// </summary>
internal sealed class StdioTransport : IMcpTransport, IDisposable
{
    private readonly Stream input;
    private readonly Stream output;
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly bool ownsStreams;

    public StdioTransport()
        : this(Console.OpenStandardInput(), Console.OpenStandardOutput(), ownsStreams: true)
    {
    }

    public StdioTransport(Stream input, Stream output, bool ownsStreams = false)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);

        this.input = input;
        this.output = output;
        this.ownsStreams = ownsStreams;
    }

    /// <summary>Reads HTTP-style headers from the stream and extracts the Content-Length value.</summary>
    public static async Task<int?> ReadHeadersAsync(Stream stream, CancellationToken ct)
    {
        var sb = new StringBuilder(64);
        int state = 0; // counts consecutive terminator bytes (\r\n\r\n)
        byte[] one = new byte[1];

        while (state < 4)
        {
            int n = await stream.ReadAsync(one.AsMemory(0, 1), ct).ConfigureAwait(false);
            if (n == 0)
            {
                return null;
            }

            byte b = one[0];
            _ = sb.Append((char)b);
            state = b switch
            {
                (byte)'\r' when state is 0 or 2 => state + 1,
                (byte)'\n' when state is 1 or 3 => state + 1,
                _ => 0,
            };
        }

        string headers = sb.ToString();
        foreach (string rawLine in headers.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
        {
            int colon = rawLine.IndexOf(':', StringComparison.Ordinal);
            if (colon <= 0)
            {
                continue;
            }

            if (rawLine.AsSpan(0, colon).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(rawLine.AsSpan(colon + 1).Trim(), out int len))
            {
                return len;
            }
        }

        return null;
    }

    /// <inheritdoc/>
    public async ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct)
    {
        int? contentLength = await ReadHeadersAsync(this.input, ct).ConfigureAwait(false);
        if (contentLength is null)
        {
            return null;
        }

        byte[] buffer = ArrayPool<byte>.Shared.Rent(contentLength.Value);
        try
        {
            int offset = 0;
            while (offset < contentLength.Value)
            {
                int n = await this.input.ReadAsync(buffer.AsMemory(offset, contentLength.Value - offset), ct).ConfigureAwait(false);
                if (n == 0)
                {
                    return null;
                }

                offset += n;
            }

            return FramingCodec.Decode(new ReadOnlySpan<byte>(buffer, 0, contentLength.Value));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    /// <inheritdoc/>
    public async ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(envelope);

        byte[] payload = FramingCodec.Encode(envelope);
        byte[] header = Encoding.ASCII.GetBytes($"Content-Length: {payload.Length}\r\n\r\n");

        await this.writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await this.output.WriteAsync(header, ct).ConfigureAwait(false);
            await this.output.WriteAsync(payload, ct).ConfigureAwait(false);
            await this.output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _ = this.writeLock.Release();
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        this.writeLock.Dispose();
        if (this.ownsStreams)
        {
            this.input.Dispose();
            this.output.Dispose();
        }
    }
}
