// <copyright file="AgentRunnerFactory.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Frozen;

namespace AiOrchestrator.Agent;

/// <summary>
/// Resolves <see cref="IAgentRunner"/> implementations by <see cref="AgentRunnerKind"/> (INV-11, INV-12).
/// </summary>
public sealed class AgentRunnerFactory
{
    private readonly FrozenDictionary<AgentRunnerKind, IAgentRunner> runners;

    /// <summary>Initializes a new instance of the <see cref="AgentRunnerFactory"/> class.</summary>
    /// <param name="runners">All registered <see cref="IAgentRunner"/> implementations (INV-11).</param>
    /// <exception cref="ArgumentNullException">Thrown when <paramref name="runners"/> is null.</exception>
    /// <exception cref="InvalidOperationException">
    /// Thrown when multiple runners report the same <see cref="AgentRunnerKind"/>.
    /// </exception>
    public AgentRunnerFactory(IEnumerable<IAgentRunner> runners)
    {
        ArgumentNullException.ThrowIfNull(runners);

        var map = new Dictionary<AgentRunnerKind, IAgentRunner>();
        foreach (var runner in runners)
        {
            if (runner is null)
            {
                throw new ArgumentException("Runner collection contains a null entry.", nameof(runners));
            }

            if (!map.TryAdd(runner.Kind, runner))
            {
                throw new InvalidOperationException(
                    $"Duplicate runner registration for kind '{runner.Kind}'.");
            }
        }

        this.runners = map.ToFrozenDictionary();
    }

    /// <summary>Resolves the runner for the supplied kind.</summary>
    /// <param name="kind">The runner kind.</param>
    /// <returns>The matching <see cref="IAgentRunner"/>.</returns>
    /// <exception cref="AgentRunnerNotInstalledException">
    /// Thrown when no runner is registered for <paramref name="kind"/>.
    /// </exception>
    public IAgentRunner Resolve(AgentRunnerKind kind)
    {
        if (!this.runners.TryGetValue(kind, out var runner))
        {
            throw new AgentRunnerNotInstalledException(kind, kind.ToString());
        }

        return runner;
    }
}
