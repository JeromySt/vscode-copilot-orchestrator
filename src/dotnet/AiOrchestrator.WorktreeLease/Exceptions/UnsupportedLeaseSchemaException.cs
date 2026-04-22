// <copyright file="UnsupportedLeaseSchemaException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.WorktreeLease.Exceptions;

/// <summary>Thrown when the on-disk lease file declares a schema version the reader does not know (INV-8).</summary>
#pragma warning disable CA1032 // Implement standard exception constructors — required state is mandatory.
public sealed class UnsupportedLeaseSchemaException : Exception
#pragma warning restore CA1032
{
    /// <summary>Initializes a new instance of the <see cref="UnsupportedLeaseSchemaException"/> class.</summary>
    /// <param name="observedVersion">The unknown schema version string found in the lease file.</param>
    public UnsupportedLeaseSchemaException(string observedVersion)
        : base($"Unsupported lease schema version '{observedVersion}'. Expected '1'.")
    {
        this.ObservedVersion = observedVersion;
    }

    /// <summary>Gets the unsupported schema version string encountered in the lease file.</summary>
    public string ObservedVersion { get; }
}
