// <copyright file="GitOperationException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Base type for all typed git operation failures (LG2-BRK-* family).</summary>
public abstract class GitOperationException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="GitOperationException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    protected GitOperationException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }
}
