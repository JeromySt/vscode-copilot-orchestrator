// <copyright file="HookApproval.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.HookGate;

/// <summary>
/// An unforgeable hook-approval token issued by <see cref="HookGateDaemon"/>. The token is
/// an HMAC-SHA256 over the canonical form of the check-in request, keyed by the daemon's
/// current nonce (INV-6).
/// </summary>
public sealed record HookApproval
{
    /// <summary>Gets the opaque token id (typically a random string).</summary>
    public required string TokenId { get; init; }

    /// <summary>Gets the raw HMAC-SHA256 over the canonicalized request.</summary>
    public required byte[] Hmac { get; init; }

    /// <summary>Gets the UTC timestamp at which the approval was issued.</summary>
    public required DateTimeOffset IssuedAt { get; init; }

    /// <summary>Gets the UTC expiry after which the approval must not be honoured.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Gets the principal to which the approval was issued.</summary>
    public required AuthContext Principal { get; init; }
}
