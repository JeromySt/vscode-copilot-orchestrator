// <copyright file="RefNotFoundException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when an operation references a ref that does not exist.</summary>
public sealed class RefNotFoundException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="RefNotFoundException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public RefNotFoundException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the qualified ref name that was not found.</summary>
    public required string RefName { get; init; }
}
