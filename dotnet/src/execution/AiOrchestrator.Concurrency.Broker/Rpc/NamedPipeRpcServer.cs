// <copyright file="NamedPipeRpcServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.IO.Pipes;
using System.Security.Principal;
using AiOrchestrator.Concurrency.Broker.Fairness;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Concurrency.Broker.Rpc;

/// <summary>
/// RPC server that listens on a Windows named pipe.
/// CONC-BROKER-3 (Windows): uses <see cref="NamedPipeServerStream.RunAsClient"/> /
/// <c>GetNamedPipeClientProcessId</c> to check peer identity per message.
/// </summary>
[ExcludeFromCodeCoverage(Justification = "Requires live OS named-pipe; covered by integration tests.")]
public sealed class NamedPipeRpcServer : IRpcServer
{
    private readonly IOptionsMonitor<BrokerOptions> opts;
    private readonly FairnessScheduler scheduler;
    private readonly ILogger<NamedPipeRpcServer> logger;
    private CancellationTokenSource? cts;
    private Task? acceptLoop;

    /// <summary>
    /// Initializes a new instance of the <see cref="NamedPipeRpcServer"/> class.
    /// </summary>
    /// <param name="opts">Broker options (pipe name, etc.).</param>
    /// <param name="scheduler">The fairness scheduler to use for slot arbitration.</param>
    /// <param name="logger">Logger for diagnostic output.</param>
    public NamedPipeRpcServer(
        IOptionsMonitor<BrokerOptions> opts,
        FairnessScheduler scheduler,
        ILogger<NamedPipeRpcServer> logger)
    {
        this.opts = opts;
        this.scheduler = scheduler;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public Task StartAsync(CancellationToken ct)
    {
        this.cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        this.acceptLoop = Task.Run(() => this.AcceptLoopAsync(this.cts.Token), this.cts.Token);
        this.logger.LogInformation("Broker named-pipe server listening at {PipeName}", this.opts.CurrentValue.PipeName);
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public async Task StopAsync(CancellationToken ct)
    {
        this.cts?.Cancel();
        if (this.acceptLoop != null)
        {
            try
            {
                await this.acceptLoop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected.
            }
        }

        this.logger.LogInformation("Broker named-pipe server stopped.");
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        await this.StopAsync(CancellationToken.None).ConfigureAwait(false);
        this.cts?.Dispose();
    }

    private static NamedPipeServerStream CreatePipeServer(string pipeName)
    {
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        var pipeName = this.ExtractPipeName(this.opts.CurrentValue.PipeName);
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = CreatePipeServer(pipeName);
                await pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
                _ = Task.Run(() => this.HandleClientAsync(pipe, ct), ct);
            }
            catch (OperationCanceledException)
            {
                pipe?.Dispose();
                break;
            }
            catch (Exception ex)
            {
                pipe?.Dispose();
                this.logger.LogWarning(ex, "Broker named-pipe: error accepting connection");
            }
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        try
        {
            using (pipe)
            {
                using var reader = new StreamReader(pipe);
                await using var writer = new StreamWriter(pipe) { AutoFlush = true };

                while (!ct.IsCancellationRequested && pipe.IsConnected)
                {
                    var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                    if (line == null)
                    {
                        break;
                    }

                    // CONC-BROKER-3: impersonate per message to verify caller identity.
                    pipe.RunAsClient(() =>
                    {
                        var identity = WindowsIdentity.GetCurrent();
                        if (identity.IsAnonymous)
                        {
                            throw new UnauthorizedAccessException("Anonymous pipe client rejected.");
                        }
                    });

                    await writer.WriteLineAsync("ACK").ConfigureAwait(false);
                }
            }
        }
        catch (Exception ex)
        {
            this.logger.LogDebug(ex, "Broker named-pipe: client handler exited");
        }
    }

    private string ExtractPipeName(string fullPipeName)
    {
        // Convert \\.\pipe\Name → Name for NamedPipeServerStream.
        const string prefix = @"\\.\pipe\";
        return fullPipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? fullPipeName[prefix.Length..]
            : fullPipeName;
    }
}
