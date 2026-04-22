// <copyright file="PortabilitySchemaMismatchException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Portability;

/// <summary>Thrown when an imported archive declares a schema version incompatible with the runtime (PORT-4).</summary>
public sealed class PortabilitySchemaMismatchException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="PortabilitySchemaMismatchException"/> class.</summary>
    public PortabilitySchemaMismatchException()
        : base("Portability archive schema version is incompatible with the runtime.")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="PortabilitySchemaMismatchException"/> class with a message.</summary>
    /// <param name="message">The message.</param>
    public PortabilitySchemaMismatchException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="PortabilitySchemaMismatchException"/> class with a message and inner exception.</summary>
    /// <param name="message">The message.</param>
    /// <param name="innerException">The inner exception.</param>
    public PortabilitySchemaMismatchException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>Gets the schema version expected by the runtime.</summary>
    public required Version Expected { get; init; }

    /// <summary>Gets the schema version found in the archive manifest.</summary>
    public required Version Actual { get; init; }
}
