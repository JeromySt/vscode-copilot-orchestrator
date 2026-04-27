// <copyright file="DaemonStartHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Composition;
using AiOrchestrator.Logging.Telemetry;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Cli.Verbs.Daemon;

/// <summary>
/// Handler for <c>aio daemon start</c>. Starts a long-running daemon that
/// listens on a named pipe for MCP clients, serving one client at a time.
/// Writes <c>READY</c> to stderr once the pipe is created and listening.
/// </summary>
internal sealed class DaemonStartHandler : VerbBase
{
    private readonly Option<string?> pipeNameOption = new("--pipe-name")
    {
        Description = "The named pipe name to listen on.",
    };

    public DaemonStartHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "daemon start";

    /// <inheritdoc/>
    protected override string Description => "Start the orchestrator daemon on a named pipe (runs until killed).";

    /// <inheritdoc/>
    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--pipe-name <name>  The named pipe name to listen on (required).",
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
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--pipe-name is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        IEnumerable<IMcpTool> tools = BuildToolSet();
        ILogger<McpServer> logger = NullLogger<McpServer>.Instance;

        // Read the per-instance auth nonce from the environment. The spawning process
        // (VS Code) sets AIO_AUTH_NONCE to a random hex string. The McpServer validates
        // it on the initialize handshake — rejecting clients that don't present it.
        // When null (system-wide service mode), nonce validation is skipped.
        string? authNonce = Environment.GetEnvironmentVariable("AIO_AUTH_NONCE");
        IOptionsMonitor<McpOptions> options = new StaticOptionsMonitor<McpOptions>(
            new McpOptions { AuthNonce = authNonce });

        // Capture the current user identity for OS-level peer-credential validation.
        string expectedUser = System.Security.Principal.WindowsIdentity.GetCurrent().Name;

        // Signal readiness to the parent process.
        Console.Error.WriteLine("READY");
        Console.Error.Flush();

        // Accept loop — one client at a time.
        while (!ct.IsCancellationRequested)
        {
            using var pipeServer = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            try
            {
                await pipeServer.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            // PEER-CRED: Verify the connecting client runs as the same user.
            // Same pattern as Concurrency.Broker (CONC-BROKER-3) and HookGate (INV-1).
            if (OperatingSystem.IsWindows())
            {
                try
                {
                    string? peerUser = null;
                    pipeServer.RunAsClient(() =>
                    {
                        peerUser = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
                    });

                    if (!string.Equals(peerUser, expectedUser, StringComparison.OrdinalIgnoreCase))
                    {
                        Console.Error.WriteLine($"Rejected client: expected {expectedUser}, got {peerUser}");
                        pipeServer.Disconnect();
                        continue;
                    }
                }
                catch
                {
                    pipeServer.Disconnect();
                    continue;
                }
            }

            using var transport = new NamedPipeTransport(pipeServer);
            var registry = new McpToolRegistry(tools);

            await using var server = new McpServer(registry, transport, options, logger);

            // StartAsync kicks off the read loop in a background Task.
            await server.StartAsync(CancellationToken.None).ConfigureAwait(false);

            // StopAsync cancels the loop CTS and awaits the loop Task. The loop
            // exits when the transport returns null (client disconnect / broken pipe)
            // or when the CTS fires. Either way we land here and accept the next client.
            try
            {
                await server.StopAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Daemon shutdown requested — fall through to exit the while-loop.
            }
        }

        return CliExitCodes.Ok;
    }

    /// <summary>
    /// Builds the set of MCP tools to register by constructing a minimal DI
    /// container with the composition root extensions. Same approach as
    /// <see cref="Mcp.McpServeHandler"/>.
    /// </summary>
    private static IEnumerable<IMcpTool> BuildToolSet()
    {
        IConfiguration config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();

        _ = services.AddLogging();

        _ = services.AddSingleton<ITelemetrySink>(
            new OtlpTelemetrySink(Options.Create(new OtlpOptions())));

        _ = services.AddTime();
        _ = services.AddRedaction();
        _ = services.AddEventing(config);

        // No fixed store root — the daemon is repo-agnostic. Each tool call
        // provides repo_root and the factory creates/caches stores per repo.
        _ = services.AddPathValidator(Array.Empty<string>());
        _ = services.AddFileSystem();

        _ = services.AddPlanModels();
        _ = services.AddOptions<PlanStoreOptions>();
        _ = services.AddSingleton<IPlanStoreFactory, PlanStoreFactory>();

        _ = services.AddSingleton<Abstractions.Process.IProcessHandleRegistry, AiOrchestrator.Process.ProcessHandleRegistry>();

        _ = services.AddMcpServer(config);

        ServiceProvider provider = services.BuildServiceProvider();
        return provider.GetServices<IMcpTool>();
    }

    /// <summary>
    /// Minimal <see cref="IOptionsMonitor{T}"/> that returns a fixed value.
    /// </summary>
    private sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    {
        /// <summary>Initializes a new instance of the <see cref="StaticOptionsMonitor{T}"/> class.</summary>
        public StaticOptionsMonitor(T value) => this.CurrentValue = value;

        /// <inheritdoc/>
        public T CurrentValue { get; }

        /// <inheritdoc/>
        public T Get(string? name) => this.CurrentValue;

        /// <inheritdoc/>
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
