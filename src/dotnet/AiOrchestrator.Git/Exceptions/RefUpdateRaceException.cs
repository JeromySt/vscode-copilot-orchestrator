// <copyright file="RefUpdateRaceException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when an optimistic ref-update CAS detects another writer.</summary>
public sealed class RefUpdateRaceException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="RefUpdateRaceException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public RefUpdateRaceException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the qualified ref name (e.g. <c>refs/heads/main</c>).</summary>
    public required string RefName { get; init; }

    /// <summary>Gets the SHA the caller expected the ref to point at.</summary>
    public required CommitSha ExpectedOld { get; init; }

    /// <summary>Gets the SHA the ref actually pointed at when the swap was attempted.</summary>
    public required CommitSha ActualOld { get; init; }
}
