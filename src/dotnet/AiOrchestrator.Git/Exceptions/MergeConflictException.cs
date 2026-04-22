// <copyright file="MergeConflictException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Exceptions;

/// <summary>Thrown when a merge cannot complete due to conflicting paths.</summary>
public sealed class MergeConflictException : GitOperationException
{
    /// <summary>Initializes a new instance of the <see cref="MergeConflictException"/> class.</summary>
    /// <param name="message">A PII-safe message describing the failure.</param>
    /// <param name="inner">The underlying exception, if any.</param>
    public MergeConflictException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }

    /// <summary>Gets the paths that conflicted during the merge.</summary>
    public required ImmutableArray<RepoRelativePath> ConflictingPaths { get; init; }
}
