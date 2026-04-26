// <copyright file="CompositionRoot.Mcp.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Tools.Log;
using AiOrchestrator.Mcp.Tools.Plan;
using AiOrchestrator.Mcp.Transports;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extension for the MCP server subsystem (job 035).</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers the <see cref="McpServer"/>, its transport, tool registry, and all
    /// <see cref="IMcpTool"/> implementations under the <c>Mcp</c> configuration section.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <param name="config">The application configuration root.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddMcpServer(this IServiceCollection services, IConfiguration config)
    {
        System.ArgumentNullException.ThrowIfNull(services);
        System.ArgumentNullException.ThrowIfNull(config);

        _ = services.Configure<McpOptions>(config.GetSection("Mcp"));

        // Transport: default to stdio; other transports are instantiated by hosts that own
        // the underlying pipe/socket handle and register them explicitly.
        _ = services.AddSingleton<IMcpTransport>(_ => new StdioTransport());

        // Tools — 19 total. The registry rejects duplicates at construction time.
        _ = services.AddSingleton<IMcpTool, ScaffoldCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, AddCopilotPlanJobTool>();
        _ = services.AddSingleton<IMcpTool, AddCopilotPlanJobsTool>();
        _ = services.AddSingleton<IMcpTool, FinalizeCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, GetCopilotPlanStatusTool>();
        _ = services.AddSingleton<IMcpTool, GetCopilotPlanGraphTool>();
        _ = services.AddSingleton<IMcpTool, ResumeCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, PauseCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, CancelCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, ArchiveCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, ReshapeCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, UpdateCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, UpdateCopilotPlanJobTool>();
        _ = services.AddSingleton<IMcpTool, BulkUpdateCopilotPlanJobsTool>();
        _ = services.AddSingleton<IMcpTool, CloneCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, ForceFailCopilotJobTool>();
        _ = services.AddSingleton<IMcpTool, RunCopilotIntegrationTestTool>();
        _ = services.AddSingleton<IMcpTool, DeleteCopilotPlanTool>();
        _ = services.AddSingleton<IMcpTool, GetOrchestratorLogsTool>();

        _ = services.AddSingleton<McpToolRegistry>();
        _ = services.AddSingleton<McpServer>();
        _ = services.AddSingleton<IHostedService>(sp => sp.GetRequiredService<McpServer>());

        return services;
    }
}
