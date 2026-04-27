// <copyright file="McpBridgeHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs.Mcp;

/// <summary>
/// Handler for <c>aio mcp bridge</c>. Thin stdio-to-named-pipe relay.
/// VS Code spawns this process as an MCP stdio server; it connects to the
/// already-running daemon's named pipe and copies bytes bidirectionally.
/// No DI, no tools — just a transparent pipe bridge.
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
            await client.ConnectAsync(10_000, ct).ConfigureAwait(false); // 10s timeout
        }
        catch (TimeoutException)
        {
            Console.Error.WriteLine($"Failed to connect to daemon pipe '{pipeName}' within 10s");
            return CliExitCodes.DaemonUnavailable;
        }

        // Bidirectional relay: stdin → pipe, pipe → stdout
        var stdinToPipe = RelayAsync(Console.OpenStandardInput(), client, ct);
        var pipeToStdout = RelayAsync(client, Console.OpenStandardOutput(), ct);

        await Task.WhenAny(stdinToPipe, pipeToStdout).ConfigureAwait(false);
        return CliExitCodes.Ok;
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
