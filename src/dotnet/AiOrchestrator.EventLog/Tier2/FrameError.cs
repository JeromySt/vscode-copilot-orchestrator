// <copyright file="FrameError.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.EventLog.Tier2;

/// <summary>Discriminator for failure modes returned by <see cref="RecordFramer.TryUnframe"/>.</summary>
public enum FrameError
{
    /// <summary>The buffer contained a complete, valid frame.</summary>
    None,

    /// <summary>Fewer than the 12 header bytes (length + recordSeq) were available.</summary>
    IncompleteHeader,

    /// <summary>Header was present but the body or trailing CRC could not yet be read in full.</summary>
    IncompleteBody,

    /// <summary>The trailing CRC32C did not match the recomputed value.</summary>
    CrcMismatch,

    /// <summary>The framed <c>recordSeq</c> regressed compared to the previously emitted record.</summary>
    RecordSeqRegression,
}
