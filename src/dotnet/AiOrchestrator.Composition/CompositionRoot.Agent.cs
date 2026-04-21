// <copyright file="CompositionRoot.Agent.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Agent;
using AiOrchestrator.Agent.Runners;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition-root extensions for the <c>AiOrchestrator.Agent</c> module.</summary>
public static partial class CompositionRoot
{
    /// <summary>
    /// Registers every <see cref="IAgentRunner"/> implementation (INV-11), the
    /// <see cref="AgentRunnerFactory"/>, and the default <see cref="IExecutableLocator"/>.
    /// </summary>
    /// <param name="services">The service collection to configure.</param>
    /// <returns>The same <paramref name="services"/> instance for chaining.</returns>
    public static IServiceCollection AddAgent(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        _ = services.AddSingleton<IExecutableLocator, DefaultExecutableLocator>();

        _ = services.AddTransient<IAgentRunner, ClaudeCodeRunner>();
        _ = services.AddTransient<IAgentRunner, CodexCliRunner>();
        _ = services.AddTransient<IAgentRunner, GeminiCliRunner>();
        _ = services.AddTransient<IAgentRunner, CopilotCliRunner>();
        _ = services.AddTransient<IAgentRunner, GhCopilotRunner>();
        _ = services.AddTransient<IAgentRunner, QwenRunner>();

        _ = services.AddSingleton<AgentRunnerFactory>();

        return services;
    }
}
