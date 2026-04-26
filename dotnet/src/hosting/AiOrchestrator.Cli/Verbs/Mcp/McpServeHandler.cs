// <copyright file="McpServeHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
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
    /// Builds the set of MCP tools to register. Currently returns an empty set;
    /// the full tool set will be wired via DI in a follow-up when the composition
    /// root is used to launch the CLI.
    /// </summary>
    private static IEnumerable<IMcpTool> BuildToolSet()
    {
        // The MCP tools (PlanToolBase derivatives, GetOrchestratorLogsTool, etc.)
        // require service dependencies injected via DI. When the CLI is launched
        // standalone without a full host, we return an empty set — the tools/list
        // response will be empty but the server handshake will work.
        //
        // When launched via the VS Code extension (which manages the daemon),
        // the full DI container supplies tools through IEnumerable<IMcpTool>.
        return Array.Empty<IMcpTool>();
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
