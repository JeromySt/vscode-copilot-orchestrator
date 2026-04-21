// <copyright file="HandleDisposedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Bindings.Node;

/// <summary>
/// Raised when a caller attempts to resolve a <see cref="HandleId"/> after the
/// owning <see cref="HandleScope"/> has been disposed.
/// </summary>
[Serializable]
public sealed class HandleDisposedException : InvalidOperationException
{
    /// <summary>Initializes a new instance of the <see cref="HandleDisposedException"/> class.</summary>
    public HandleDisposedException()
        : base("handle disposed")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="HandleDisposedException"/> class.</summary>
    /// <param name="message">A descriptive message.</param>
    public HandleDisposedException(string message)
        : base(message)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="HandleDisposedException"/> class.</summary>
    /// <param name="message">A descriptive message.</param>
    /// <param name="innerException">The underlying cause, if any.</param>
    public HandleDisposedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
