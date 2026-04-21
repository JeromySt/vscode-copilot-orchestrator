// <copyright file="AuthFailureException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when authentication against a remote fails.</summary>
public sealed class AuthFailureException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="AuthFailureException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public AuthFailureException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the remote URL for which authentication failed.</summary>
    public required Uri RepoUrl { get; init; }
}
