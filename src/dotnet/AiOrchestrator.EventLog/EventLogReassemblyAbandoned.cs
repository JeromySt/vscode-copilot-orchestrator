// <copyright file="EventLogReassemblyAbandoned.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.EventLog;

/// <summary>
/// Diagnostic event published on the bus when the T2 reassembly buffer abandons a partial record
/// because either the byte budget or the time budget was exceeded (T2-READ-11).
/// </summary>
public sealed record EventLogReassemblyAbandoned
{
    /// <summary>Gets the record sequence number that could not be reassembled.</summary>
    public long RecordSeq { get; init; }

    /// <summary>Gets the number of bytes that had been buffered when the operation was abandoned.</summary>
    public int BytesBuffered { get; init; }

    /// <summary>Gets the elapsed milliseconds spent attempting reassembly.</summary>
    public long ElapsedMs { get; init; }
}
