// <copyright file="IAuditLog.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Audit;

/// <summary>
/// Provides append-only recording of security-relevant events with chain-hash integrity verification.
/// Implementations must guarantee that the chain hash of each event is derived from the previous event,
/// enabling tamper detection.
/// </summary>
public interface IAuditLog
{
    /// <summary>Appends a single audit event to the log.</summary>
    /// <param name="event">The event to record.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="ValueTask"/> that completes when the event has been durably written.</returns>
    ValueTask AppendAsync(AuditEvent @event, CancellationToken ct);

    /// <summary>Reads all audit events in ascending sequence order.</summary>
    /// <param name="ct">Cancellation token. Cancel to stop enumeration.</param>
    /// <returns>An async enumerable of all audit events.</returns>
    IAsyncEnumerable<AuditEvent> ReadAsync(CancellationToken ct);

    /// <summary>Verifies the integrity of the audit event chain according to the provided options.</summary>
    /// <param name="opts">Options controlling the verification scope.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A <see cref="AuditChainResult"/> describing whether the chain is intact.</returns>
    ValueTask<AuditChainResult> VerifyAsync(AuditVerifyOptions opts, CancellationToken ct);
}
