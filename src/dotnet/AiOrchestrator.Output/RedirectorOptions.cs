// <copyright file="RedirectorOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;

namespace AiOrchestrator.Output;

/// <summary>Options governing <see cref="StreamRedirector"/> ring buffer and per-consumer queue depths.</summary>
public sealed record RedirectorOptions
{
    /// <summary>Gets the per-stream ring buffer size in bytes (default 256 KiB).</summary>
    [Range(1024, 1024 * 1024)]
    public int RingBufferBytes { get; init; } = 256 * 1024;

    /// <summary>Gets the per-consumer bounded queue depth (default 1024 chunks).</summary>
    public int PerConsumerQueueDepth { get; init; } = 1024;

    /// <summary>
    /// Gets the maximum number of bytes emitted per <see cref="OutputChunk"/>.
    /// Larger reads from the underlying <see cref="System.IO.Pipelines.PipeReader"/> are
    /// sliced into multiple chunks of at most this many bytes (default 8 to preserve write
    /// boundaries when callers flush small writes).
    /// </summary>
    [Range(1, 1024 * 1024)]
    public int MaxChunkBytes { get; init; } = 8;

    /// <summary>
    /// Gets the per-publish budget (milliseconds) granted to a saturated consumer
    /// to free queue space before its chunk is dropped and a ConsumerLagged event
    /// is emitted (default 1 ms — small enough that 1000 publishes to a
    /// permanently-blocked consumer complete in well under 2 s, big enough that
    /// fast consumers under brief contention drain without dropping).
    /// </summary>
    [Range(1, 1000)]
    public int LagWriteBudgetMs { get; init; } = 1;
}
