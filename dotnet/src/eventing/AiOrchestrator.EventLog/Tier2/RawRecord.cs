// <copyright file="RawRecord.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>A struct view over a successfully framed record. Allocation-free on the happy path.</summary>
/// <param name="RecordSeq">The monotonic sequence number carried by the frame.</param>
/// <param name="Payload">The opaque payload bytes (the framing header + CRC are stripped).</param>
internal readonly record struct RawRecord(long RecordSeq, ReadOnlyMemory<byte> Payload);
