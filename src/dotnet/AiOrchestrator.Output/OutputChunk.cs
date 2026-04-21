// <copyright file="OutputChunk.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Output;

/// <summary>
/// A single chunk of bytes read from a job's stdout or stderr, along with the
/// monotonic byte-offset within that stream and the wall-clock timestamp at which
/// it was observed by the redirector.
/// </summary>
public sealed record OutputChunk
{
    /// <summary>Gets the job that produced the chunk.</summary>
    public required JobId JobId { get; init; }

    /// <summary>Gets which standard stream the chunk came from.</summary>
    public required OutputStream Stream { get; init; }

    /// <summary>Gets the inclusive byte offset of the first byte of <see cref="Data"/> within the stream.</summary>
    public required long ByteOffset { get; init; }

    /// <summary>Gets the chunk payload. Lifetime is owned by the publishing redirector / pool.</summary>
    public required ReadOnlyMemory<byte> Data { get; init; }

    /// <summary>Gets the wall-clock instant at which the redirector observed the chunk.</summary>
    public required DateTimeOffset At { get; init; }
}
