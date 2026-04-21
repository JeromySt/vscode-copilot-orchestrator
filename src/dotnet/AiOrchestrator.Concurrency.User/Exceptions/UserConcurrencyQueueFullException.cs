// <copyright file="UserConcurrencyQueueFullException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Concurrency.User.Exceptions;

/// <summary>
/// Thrown when a new per-user concurrency request cannot be enqueued because the
/// FIFO queue has reached its configured depth limit.
/// </summary>
public sealed class UserConcurrencyQueueFullException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="UserConcurrencyQueueFullException"/> class.
    /// </summary>
    /// <param name="queueDepth">The queue depth limit that was exceeded.</param>
    public UserConcurrencyQueueFullException(int queueDepth)
        : base($"Per-user concurrency queue is full (depth={queueDepth}).")
    {
        this.QueueDepth = queueDepth;
    }

    /// <summary>Gets the queue depth limit that was exceeded.</summary>
    public int QueueDepth { get; }
}
