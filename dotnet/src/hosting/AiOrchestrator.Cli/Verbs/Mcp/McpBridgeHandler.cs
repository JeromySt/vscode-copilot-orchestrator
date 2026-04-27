// <copyright file="McpBridgeHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Mcp;

/// <summary>
/// Handler for <c>aio mcp bridge</c>. Stdio-to-named-pipe relay with
/// nonce injection. VS Code spawns this process as an MCP stdio server;
/// it connects to the daemon's named pipe and relays bytes bidirectionally.
/// The first <c>initialize</c> request from stdin is intercepted to inject
/// the <c>AIO_AUTH_NONCE</c> into <c>clientInfo.nonce</c> so the daemon's
/// nonce validation passes.
/// </summary>
internal sealed class McpBridgeHandler : VerbBase
{
    private readonly Option<string?> pipeNameOption = new("--pipe-name")
    {
        Description = "The named pipe to connect to (must match the daemon's --pipe-name).",
    };

    public McpBridgeHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "mcp bridge";

    /// <inheritdoc/>
    protected override string Description => "Bridge stdin/stdout to a daemon named pipe (used by VS Code MCP).";

    /// <inheritdoc/>
    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--pipe-name <name>  The named pipe to connect to (required).",
    };

    /// <inheritdoc/>
    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.pipeNameOption);
    }

    /// <inheritdoc/>
    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? pipeName = result.GetValue(this.pipeNameOption);
        if (string.IsNullOrEmpty(pipeName))
        {
            Console.Error.WriteLine("--pipe-name is required");
            return CliExitCodes.UsageError;
        }

        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

        try
        {
            await client.ConnectAsync(10_000, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Console.Error.WriteLine($"Failed to connect to daemon pipe '{pipeName}' within 10s");
            return CliExitCodes.DaemonUnavailable;
        }

        string? authNonce = Environment.GetEnvironmentVariable("AIO_AUTH_NONCE");
        Console.Error.WriteLine($"[bridge] Connected to pipe '{pipeName}', nonce={(!string.IsNullOrEmpty(authNonce) ? "set" : "none")}");

        // Open stdin/stdout ONCE before spawning tasks — Console.OpenStandardInput()
        // inside Task.Run can race with VS Code's writes on Windows.
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();

        // If nonce is set, intercept the first frame synchronously before starting relay
        if (!string.IsNullOrEmpty(authNonce))
        {
            Console.Error.WriteLine("[bridge] Reading first frame from stdin for nonce injection...");
            var firstFrame = await ReadOneFrameAsync(stdin, ct).ConfigureAwait(false);
            if (firstFrame is not null)
            {
                Console.Error.WriteLine($"[bridge] Got first frame ({firstFrame.Length} chars), injecting nonce");
                string patched = InjectNonce(firstFrame, authNonce!);
                byte[] patchedBytes = Encoding.UTF8.GetBytes(patched);
                string header = $"Content-Length: {patchedBytes.Length}\r\n\r\n";
                byte[] headerBytes = Encoding.UTF8.GetBytes(header);
                await client.WriteAsync(headerBytes, ct).ConfigureAwait(false);
                await client.WriteAsync(patchedBytes, ct).ConfigureAwait(false);
                await client.FlushAsync(ct).ConfigureAwait(false);
                Console.Error.WriteLine($"[bridge] Nonce injected and forwarded ({patchedBytes.Length}b)");
            }
            else
            {
                Console.Error.WriteLine("[bridge] WARNING: Failed to read first frame from stdin");
            }
        }

        Console.Error.WriteLine("[bridge] Starting bidirectional relay");

        // Now relay remaining stdin → pipe and pipe → stdout
        var stdinToPipe = RelayAsync(stdin, client, ct);
        var pipeToStdout = RelayAsync(client, stdout, ct);

        await Task.WhenAny(stdinToPipe, pipeToStdout).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }

    /// <summary>Reads one Content-Length framed message body from the stream.</summary>
    private static async Task<string?> ReadOneFrameAsync(Stream stream, CancellationToken ct)
    {
        // Use a StreamReader for buffered reading (byte-by-byte ReadAsync on
        // Console.OpenStandardInput can stall on Windows)
        var buf = new byte[16384];
        int total = 0;

        // Read enough to find \r\n\r\n header terminator
        while (total < buf.Length)
        {
            int n = await stream.ReadAsync(buf.AsMemory(total, Math.Min(4096, buf.Length - total)), ct).ConfigureAwait(false);
            if (n == 0) return null;
            total += n;

            // Check if we have the header terminator
            var text = Encoding.UTF8.GetString(buf, 0, total);
            int headerEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (headerEnd >= 0)
            {
                // Parse Content-Length from headers
                string headers = text[..headerEnd];
                int clStart = headers.IndexOf("Content-Length:", StringComparison.OrdinalIgnoreCase);
                if (clStart < 0) return null;
                int valStart = clStart + "Content-Length:".Length;
                int lineEnd = headers.IndexOf("\r\n", valStart, StringComparison.Ordinal);
                if (lineEnd < 0) lineEnd = headers.Length;
                if (!int.TryParse(headers[valStart..lineEnd].Trim(), out int contentLength)) return null;

                int bodyStart = headerEnd + 4;
                int bodyBytesAvailable = total - bodyStart;

                // Read remaining body bytes if needed
                if (bodyBytesAvailable < contentLength)
                {
                    int need = contentLength - bodyBytesAvailable;
                    if (total + need > buf.Length)
                    {
                        Array.Resize(ref buf, total + need);
                    }

                    while (bodyBytesAvailable < contentLength)
                    {
                        int r = await stream.ReadAsync(buf.AsMemory(total, contentLength - bodyBytesAvailable), ct).ConfigureAwait(false);
                        if (r == 0) return null;
                        total += r;
                        bodyBytesAvailable += r;
                    }
                }

                return Encoding.UTF8.GetString(buf, bodyStart, contentLength);
            }
        }

        return null; // Header too large
    }

    /// <summary>Injects <c>clientInfo.nonce</c> into a JSON-RPC initialize request body.</summary>
    private static string InjectNonce(string jsonBody, string nonce)
    {
        try
        {
            var node = JsonNode.Parse(jsonBody);
            if (node is JsonObject obj &&
                obj["params"] is JsonObject prms &&
                prms["clientInfo"] is JsonObject clientInfo)
            {
                clientInfo["nonce"] = JsonValue.Create(nonce);
                return node.ToJsonString();
            }
        }
        catch
        {
            // If parsing fails, pass through unmodified
        }

        return jsonBody;
    }

    private static async Task RelayAsync(Stream source, Stream destination, CancellationToken ct)
    {
        var buffer = new byte[8192];
        try
        {
            while (!ct.IsCancellationRequested)
            {
                int bytesRead = await source.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (bytesRead == 0)
                {
                    break; // EOF
                }

                await destination.WriteAsync(buffer.AsMemory(0, bytesRead), ct).ConfigureAwait(false);
                await destination.FlushAsync(ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
            // Pipe broken — client disconnected
        }
    }
}
