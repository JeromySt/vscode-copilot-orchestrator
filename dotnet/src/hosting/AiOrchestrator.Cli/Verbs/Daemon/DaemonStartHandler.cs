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

        var (tools, serviceProvider) = BuildToolSet();

        // Use the DI-resolved logger so messages go to the rolling file log
        // AND to stderr (which the extension captures in the VS Code Output channel).
        ILogger<McpServer> logger = serviceProvider.GetRequiredService<ILoggerFactory>().CreateLogger<McpServer>();
        logger.LogInformation("Daemon starting on pipe {PipeName}", pipeName);

        // Read the per-instance auth nonce from the environment. The spawning process
        // (VS Code) sets AIO_AUTH_NONCE to a random hex string. The McpServer validates
        // it on the initialize handshake — rejecting clients that don't present it.
        // When null (system-wide service mode), nonce validation is skipped.
        string? authNonce = Environment.GetEnvironmentVariable("AIO_AUTH_NONCE");
        IOptionsMonitor<McpOptions> options = new StaticOptionsMonitor<McpOptions>(
            new McpOptions { AuthNonce = authNonce });

        // Signal readiness to the parent process.
        Console.Error.WriteLine("READY");
        Console.Error.Flush();

        // Multi-client accept loop — each connection runs in its own task.
        // NamedPipeServerStream.MaxAllowedServerInstances allows unlimited
        // concurrent pipe instances with the same name.
        var activeSessions = new List<Task>();

        while (!ct.IsCancellationRequested)
        {
            var pipeServer = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);

            try
            {
                await pipeServer.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                pipeServer.Dispose();
                break;
            }

            // Spawn a session task for this client — don't block the accept loop.
            logger.LogInformation("Client connected to pipe {PipeName} (session #{Count})", pipeName, activeSessions.Count + 1);
            activeSessions.Add(HandleClientSessionAsync(pipeServer, tools, options, logger, ct));

            // Clean up completed sessions.
            activeSessions.RemoveAll(t => t.IsCompleted);
        }

        // Wait for all active sessions to finish.
        await Task.WhenAll(activeSessions).ConfigureAwait(false);

        return CliExitCodes.Ok;
    }

    /// <summary>
    /// Handles a single client session on a connected pipe. Runs until the
    /// client disconnects or the daemon shutdown token fires.
    /// </summary>
    private static async Task HandleClientSessionAsync(
        NamedPipeServerStream pipeServer,
        IEnumerable<IMcpTool> tools,
        IOptionsMonitor<McpOptions> options,
        ILogger<McpServer> logger,
        CancellationToken ct)
    {
        try
        {
            using (pipeServer)
            using (var transport = new NamedPipeTransport(pipeServer))
            {
                var registry = new McpToolRegistry(tools);
                await using var server = new McpServer(registry, transport, options, logger);

                await server.StartAsync(CancellationToken.None).ConfigureAwait(false);
                logger.LogInformation("MCP session started for client");

                try
                {
                    await server.WaitForLoopAsync().ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Client disconnected or daemon shutting down.
                }

                logger.LogInformation("MCP session ended for client");
            }
        }
#pragma warning disable CA1031 // Per-session isolation — don't crash the daemon
        catch (Exception ex)
        {
            logger.LogError(ex, "Client session error");
        }
#pragma warning restore CA1031
    }

    /// <summary>
    /// Builds the set of MCP tools to register by constructing a minimal DI
    /// container with the composition root extensions. Same approach as
    /// <see cref="Mcp.McpServeHandler"/>.
    /// </summary>
    private static (IMcpTool[] Tools, ServiceProvider Provider) BuildToolSet()
    {
        IConfiguration config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();

        _ = services.AddLogging(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Information);
            // Console logger — route all log levels to stderr so the extension
            // captures them in the VS Code Output channel. Stdout is reserved
            // for future protocol use.
            builder.AddConsole(opts => opts.LogToStandardErrorThreshold = LogLevel.Trace);
        });

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
        _ = services.AddSingleton<AiOrchestrator.Plan.Store.Migration.IPlanMigrator, AiOrchestrator.Plan.Store.Migration.TsPlanMigrator>();
        _ = services.AddSingleton<IPlanStoreFactory, PlanStoreFactory>();

        _ = services.AddSingleton<Abstractions.Process.IProcessHandleRegistry, AiOrchestrator.Process.ProcessHandleRegistry>();

        _ = services.AddMcpServer(config);

        ServiceProvider provider = services.BuildServiceProvider();
        return (provider.GetServices<IMcpTool>().ToArray(), provider);
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
