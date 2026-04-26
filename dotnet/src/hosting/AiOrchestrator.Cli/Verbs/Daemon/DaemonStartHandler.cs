// <copyright file="DaemonStartHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Telemetry;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Composition;
using AiOrchestrator.Logging.Telemetry;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
using AiOrchestrator.Models.Paths;
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

    private readonly Option<string?> repoRootOption = new("--repo-root")
    {
        Description = "Absolute path to the repository root for repo-scoped operations.",
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
        "--repo-root <path>  Absolute path to the repository root for repo-scoped operations.",
    };

    /// <inheritdoc/>
    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.pipeNameOption);
        command.Options.Add(this.repoRootOption);
    }

    /// <inheritdoc/>
    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? pipeName = result.GetValue(this.pipeNameOption);
        string? repoRoot = result.GetValue(this.repoRootOption);

        if (string.IsNullOrEmpty(pipeName))
        {
            await this.WriteVerbResultAsync(result, new VerbResult(this.VerbPath, false, "--pipe-name is required", CliExitCodes.UsageError), ct).ConfigureAwait(false);
            return CliExitCodes.UsageError;
        }

        if (!string.IsNullOrEmpty(repoRoot))
        {
            Environment.SetEnvironmentVariable("AIO_REPO_ROOT", repoRoot);
        }

        IEnumerable<IMcpTool> tools = BuildToolSet(repoRoot);
        ILogger<McpServer> logger = NullLogger<McpServer>.Instance;
        IOptionsMonitor<McpOptions> options = new StaticOptionsMonitor<McpOptions>(new McpOptions());

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
    private static IEnumerable<IMcpTool> BuildToolSet(string? repoRoot)
    {
        IConfiguration config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();

        _ = services.AddLogging();

        _ = services.AddSingleton<ITelemetrySink>(
            new OtlpTelemetrySink(Options.Create(new OtlpOptions())));

        _ = services.AddTime();
        _ = services.AddEventing(config);

        AbsolutePath storeRoot = ComputeStoreRoot(repoRoot);
        _ = services.AddPathValidator(new[] { storeRoot.Value });
        _ = services.AddFileSystem();

        _ = services.AddPlanModels();
        _ = services.AddOptions<PlanStoreOptions>();
        _ = services.AddSingleton<IPlanStore>(sp => new PlanStore(
            storeRoot,
            sp.GetRequiredService<Abstractions.Io.IFileSystem>(),
            sp.GetRequiredService<IClock>(),
            sp.GetRequiredService<Abstractions.Eventing.IEventBus>(),
            sp.GetRequiredService<IOptionsMonitor<PlanStoreOptions>>(),
            sp.GetRequiredService<ILogger<PlanStore>>()));

        _ = services.AddSingleton<Abstractions.Process.IProcessHandleRegistry, AiOrchestrator.Process.ProcessHandleRegistry>();

        _ = services.AddMcpServer(config);

        ServiceProvider provider = services.BuildServiceProvider();
        return provider.GetServices<IMcpTool>();
    }

    private static AbsolutePath ComputeStoreRoot(string? repoRoot)
    {
        if (!string.IsNullOrEmpty(repoRoot))
        {
            return new AbsolutePath(Path.Combine(repoRoot, ".orchestrator", "plans"));
        }

        return new AbsolutePath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ai-orchestrator"));
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
