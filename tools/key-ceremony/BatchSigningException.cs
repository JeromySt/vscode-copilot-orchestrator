// <copyright file="BatchSigningException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Thrown when the ceremony detects an attempt to batch-sign multiple payloads in one HSM session (INV-2).</summary>
public sealed class BatchSigningException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="BatchSigningException"/> class.</summary>
    public BatchSigningException()
        : base("Batch signing is forbidden: each operator must confirm and sign individually.")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BatchSigningException"/> class.</summary>
    /// <param name="message">The error message.</param>
    public BatchSigningException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BatchSigningException"/> class.</summary>
    /// <param name="message">The error message.</param>
    /// <param name="inner">The inner exception.</param>
    public BatchSigningException(string message, Exception inner)
        : base(message, inner)
    {
    }
}
