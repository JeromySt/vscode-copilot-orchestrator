// <copyright file="AgentRunnerNotInstalledException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Agent;

/// <summary>Raised when an agent runner's executable cannot be located on <c>PATH</c> (INV-12).</summary>
[Serializable]
public sealed class AgentRunnerNotInstalledException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="AgentRunnerNotInstalledException"/> class.</summary>
    /// <param name="kind">The runner kind that failed to resolve.</param>
    /// <param name="probedPath">The executable name or path probed.</param>
    public AgentRunnerNotInstalledException(AgentRunnerKind kind, string probedPath)
        : base($"Agent runner '{kind}' is not installed; probed '{probedPath}' on PATH.")
    {
        this.Kind = kind;
        this.ProbedPath = probedPath;
    }

    /// <summary>Initializes a new instance of the <see cref="AgentRunnerNotInstalledException"/> class.</summary>
    public AgentRunnerNotInstalledException()
        : this(default, string.Empty)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="AgentRunnerNotInstalledException"/> class.</summary>
    /// <param name="message">The message.</param>
    public AgentRunnerNotInstalledException(string message)
        : base(message)
    {
        this.ProbedPath = string.Empty;
    }

    /// <summary>Initializes a new instance of the <see cref="AgentRunnerNotInstalledException"/> class.</summary>
    /// <param name="message">The message.</param>
    /// <param name="innerException">The inner exception.</param>
    public AgentRunnerNotInstalledException(string message, Exception innerException)
        : base(message, innerException)
    {
        this.ProbedPath = string.Empty;
    }

    /// <summary>Gets the runner kind that failed to resolve.</summary>
    public AgentRunnerKind Kind { get; }

    /// <summary>Gets the executable name or path that was probed.</summary>
    public string ProbedPath { get; } = string.Empty;
}
