// <copyright file="StaleLeaseTokenException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.WorktreeLease.Exceptions;

/// <summary>Thrown by <c>EnforceWriteWithTokenAsync</c> when the caller's token is stale (LS-INF-1).</summary>
#pragma warning disable CA1032 // Implement standard exception constructors — required state is mandatory.
public sealed class StaleLeaseTokenException : Exception
#pragma warning restore CA1032
{
    /// <summary>Initializes a new instance of the <see cref="StaleLeaseTokenException"/> class.</summary>
    public StaleLeaseTokenException()
        : base("The lease fencing token supplied by the caller does not match the token stored on disk.")
    {
    }

    /// <summary>Gets the token the caller provided.</summary>
    public required FencingToken ProvidedToken { get; init; }

    /// <summary>Gets the token currently stored in the lease file.</summary>
    public required FencingToken StoredToken { get; init; }
}
