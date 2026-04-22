// <copyright file="RemoteRejectedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when the remote rejected a push (e.g. non-fast-forward, hook rejection).</summary>
public sealed class RemoteRejectedException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="RemoteRejectedException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public RemoteRejectedException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the reason reported by the remote.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the remote URL that issued the rejection.</summary>
    public required string RemoteUrl { get; init; }
}
