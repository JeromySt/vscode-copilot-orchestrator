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

        // stdin → pipe: intercept the first Content-Length frame, inject nonce, then raw relay
        var stdinToPipe = Task.Run(async () =>
        {
            using var stdin = Console.OpenStandardInput();
            bool nonceInjected = false;

            if (!string.IsNullOrEmpty(authNonce))
            {
                // Read the first Content-Length framed message, inject nonce, forward
                var firstFrame = await ReadOneFrameAsync(stdin, ct).ConfigureAwait(false);
                if (firstFrame is not null)
                {
                    string patched = InjectNonce(firstFrame, authNonce!);
                    byte[] patchedBytes = Encoding.UTF8.GetBytes(patched);
                    string header = $"Content-Length: {patchedBytes.Length}\r\n\r\n";
                    byte[] headerBytes = Encoding.UTF8.GetBytes(header);
                    await client.WriteAsync(headerBytes, ct).ConfigureAwait(false);
                    await client.WriteAsync(patchedBytes, ct).ConfigureAwait(false);
                    await client.FlushAsync(ct).ConfigureAwait(false);
                    nonceInjected = true;
                    Console.Error.WriteLine($"[bridge] Injected nonce into initialize (frame={patchedBytes.Length}b)");
                }
            }

            // Raw relay for all subsequent messages
            await RelayAsync(stdin, client, ct).ConfigureAwait(false);
        }, ct);

        // pipe → stdout: pure relay (no interception needed)
        var pipeToStdout = Task.Run(async () =>
        {
            using var stdout = Console.OpenStandardOutput();
            await RelayAsync(client, stdout, ct).ConfigureAwait(false);
        }, ct);

        await Task.WhenAny(stdinToPipe, pipeToStdout).ConfigureAwait(false);
        return CliExitCodes.Ok;
    }

    /// <summary>Reads one Content-Length framed message body from the stream.</summary>
    private static async Task<string?> ReadOneFrameAsync(Stream stream, CancellationToken ct)
    {
        // Read headers until \r\n\r\n
        var headerBuf = new StringBuilder();
        int prev = -1;
        while (true)
        {
            var b = new byte[1];
            int n = await stream.ReadAsync(b, ct).ConfigureAwait(false);
            if (n == 0) return null;
            char c = (char)b[0];
            headerBuf.Append(c);
            // Detect \r\n\r\n
            if (headerBuf.Length >= 4)
            {
                string tail = headerBuf.ToString(headerBuf.Length - 4, 4);
                if (tail == "\r\n\r\n") break;
            }
        }

        // Parse Content-Length
        string headers = headerBuf.ToString();
        int clStart = headers.IndexOf("Content-Length:", StringComparison.OrdinalIgnoreCase);
        if (clStart < 0) return null;
        int valStart = clStart + "Content-Length:".Length;
        int lineEnd = headers.IndexOf("\r\n", valStart, StringComparison.Ordinal);
        if (lineEnd < 0) lineEnd = headers.Length;
        if (!int.TryParse(headers[valStart..lineEnd].Trim(), out int contentLength)) return null;

        // Read exactly contentLength bytes
        var body = new byte[contentLength];
        int totalRead = 0;
        while (totalRead < contentLength)
        {
            int n = await stream.ReadAsync(body.AsMemory(totalRead, contentLength - totalRead), ct).ConfigureAwait(false);
            if (n == 0) return null;
            totalRead += n;
        }

        return Encoding.UTF8.GetString(body);
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
