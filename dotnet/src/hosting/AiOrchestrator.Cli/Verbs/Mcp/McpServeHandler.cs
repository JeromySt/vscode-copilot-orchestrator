// <copyright file="McpServeHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
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

namespace AiOrchestrator.Cli.Verbs.Mcp;

/// <summary>
/// Handler for <c>aio mcp serve</c>. Starts the MCP server over stdio,
/// reading JSON-RPC requests from stdin and writing responses to stdout
/// until stdin is closed (EOF) or the process is killed.
/// </summary>
internal sealed class McpServeHandler : VerbBase
{
    private readonly Option<string?> repoRootOption = new("--repo-root")
    {
        Description = "Absolute path to the repository root for repo-scoped operations.",
    };

    public McpServeHandler(IServiceProvider services)
        : base(services)
    {
    }

    /// <inheritdoc/>
    public override string VerbPath => "mcp serve";

    /// <inheritdoc/>
    protected override string Description => "Start the MCP server over stdio (stdin/stdout).";

    /// <inheritdoc/>
    protected override IReadOnlyList<string> ExtraOptionHelp { get; } = new[]
    {
        "--repo-root <path>  Absolute path to the repository root for repo-scoped operations.",
    };

    /// <inheritdoc/>
    protected override void ConfigureOptions(Command command)
    {
        command.Options.Add(this.repoRootOption);
    }

    /// <inheritdoc/>
    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        string? repoRoot = result.GetValue(this.repoRootOption);

        // Use NullLogger to keep stdout clean for JSON-RPC traffic.
        // Diagnostic logging will be added when the full composition root is wired.
        ILogger<McpServer> logger = NullLogger<McpServer>.Instance;

        // Tools that need repo root can read it from the environment.
        if (!string.IsNullOrEmpty(repoRoot))
        {
            Environment.SetEnvironmentVariable("AIO_REPO_ROOT", repoRoot);
        }

        var tools = BuildToolSet();
        var registry = new McpToolRegistry(tools);
        var transport = new StdioTransport();
        IOptionsMonitor<McpOptions> options = new StaticOptionsMonitor<McpOptions>(new McpOptions());

        await using var server = new McpServer(registry, transport, options, logger);

        await server.StartAsync(ct).ConfigureAwait(false);

        // Block until the process is canceled (stdin EOF causes the server
        // loop to exit, which triggers cancellation of the host).
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using (ct.Register(() => tcs.TrySetResult()))
        {
            await tcs.Task.ConfigureAwait(false);
        }

        await server.StopAsync(CancellationToken.None).ConfigureAwait(false);

        return CliExitCodes.Ok;
    }

    /// <summary>
    /// Builds the set of MCP tools to register by constructing a minimal DI
    /// container with the composition root extensions. This gives standalone
    /// CLI invocations the same tool set that the hosted daemon exposes.
    /// </summary>
    private static IEnumerable<IMcpTool> BuildToolSet()
    {
        IConfiguration config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();

        // Logging: standard AddLogging with no providers keeps stdout clean for JSON-RPC.
        _ = services.AddLogging();

        // ITelemetrySink is required by MonotonicGuard (via AddTime). Register
        // OtlpTelemetrySink with OTLP disabled so all methods are zero-allocation no-ops.
        _ = services.AddSingleton<ITelemetrySink>(
            new OtlpTelemetrySink(Options.Create(new OtlpOptions())));

        // Core infrastructure via composition root extensions.
        _ = services.AddTime();
        _ = services.AddRedaction();
        _ = services.AddEventing(config);

        // File system — no fixed store root. The factory creates per-repo stores
        // dynamically when each tool call provides repo_root.
        _ = services.AddPathValidator(Array.Empty<string>());
        _ = services.AddFileSystem();

        // Plan subsystem: register the factory instead of a single IPlanStore.
        _ = services.AddPlanModels();
        _ = services.AddOptions<PlanStoreOptions>();
        _ = services.AddSingleton<AiOrchestrator.Plan.Store.Migration.IPlanMigrator, AiOrchestrator.Plan.Store.Migration.TsPlanMigrator>();
        _ = services.AddSingleton<IPlanStoreFactory, PlanStoreFactory>();

        // Process handle registry (empty — standalone CLI doesn't run jobs, but
        // GetCopilotJobProcessTreeTool needs the interface registered).
        _ = services.AddSingleton<Abstractions.Process.IProcessHandleRegistry, AiOrchestrator.Process.ProcessHandleRegistry>();

        // MCP tools (20 plan + log tools, registry, and server skeleton).
        _ = services.AddMcpServer(config);

        ServiceProvider provider = services.BuildServiceProvider();
        return provider.GetServices<IMcpTool>();
    }

    /// <summary>
    /// Minimal <see cref="IOptionsMonitor{T}"/> that returns a fixed value.
    /// Avoids pulling in the full Options infrastructure for a CLI command.
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
