// <copyright file="NetworkErrorException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown for network-layer failures during a remote operation.</summary>
public sealed class NetworkErrorException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="NetworkErrorException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public NetworkErrorException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the remote URL involved in the failure.</summary>
    public required Uri RepoUrl { get; init; }

    /// <summary>Gets a value indicating whether the caller may safely retry the operation.</summary>
    public required bool IsRetryable { get; init; }
}
