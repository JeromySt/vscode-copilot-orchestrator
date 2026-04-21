// <copyright file="IAuditLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Audit.Trust;

namespace AiOrchestrator.Audit;

/// <summary>
/// Tamper-evident, append-only audit log per spec §3.5. Implementations chain segments
/// via HMAC-SHA256 and sign each segment with Ed25519, anchored at install time.
/// </summary>
public interface IAuditLog
{
    /// <summary>Appends a record to the current segment, chaining and signing as needed.</summary>
    /// <param name="record">The audit record to append.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the record is durable.</returns>
    ValueTask AppendAsync(AuditRecord record, CancellationToken ct);

    /// <summary>Reads back every record in chronological order.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Async enumerable of records.</returns>
    IAsyncEnumerable<AuditRecord> ReadAsync(CancellationToken ct);

    /// <summary>Verifies the chain of segments persisted on disk.</summary>
    /// <param name="mode">Verification depth; <see cref="VerifyMode.Strict"/> additionally consults a transparency log.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A description of whether the chain is intact.</returns>
    ValueTask<ChainVerification> VerifyAsync(VerifyMode mode, CancellationToken ct);
}
