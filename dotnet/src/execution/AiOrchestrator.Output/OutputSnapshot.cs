// <copyright file="OutputSnapshot.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Output;

/// <summary>
/// Immutable point-in-time view of a job's recent stdout/stderr bytes plus the
/// monotonic totals observed so far. Returned by <see cref="StreamRedirector.SnapshotFor"/>
/// to allow late-attaching UIs to backfill before live streaming.
/// </summary>
public sealed class OutputSnapshot
{
    /// <summary>Gets the most-recent stdout bytes (up to <c>RingBufferBytes</c>).</summary>
    public required ImmutableArray<byte> RecentStdoutBytes { get; init; }

    /// <summary>Gets the most-recent stderr bytes (up to <c>RingBufferBytes</c>).</summary>
    public required ImmutableArray<byte> RecentStderrBytes { get; init; }

    /// <summary>Gets the cumulative number of bytes ever observed on stdout for the job.</summary>
    public required long TotalStdoutBytes { get; init; }

    /// <summary>Gets the cumulative number of bytes ever observed on stderr for the job.</summary>
    public required long TotalStderrBytes { get; init; }
}
