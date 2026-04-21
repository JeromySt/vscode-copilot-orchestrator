// <copyright file="EventLogRecordSeqGap.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.EventLog;

/// <summary>
/// Diagnostic event raised when the reader observes a non-contiguous jump in
/// <see cref="AiOrchestrator.Models.Eventing.EventEnvelope.RecordSeq"/> (T2-READ-11-GAP).
/// </summary>
public sealed record EventLogRecordSeqGap
{
    /// <summary>Gets the last record sequence number that was successfully read.</summary>
    public long LastSeen { get; init; }

    /// <summary>Gets the next record sequence number that was observed after the gap.</summary>
    public long NextSeen { get; init; }
}
