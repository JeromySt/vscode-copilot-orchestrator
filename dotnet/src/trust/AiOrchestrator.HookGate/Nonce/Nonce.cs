// <copyright file="Nonce.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Nonce;

/// <summary>A daemon-issued nonce used as the HMAC key for hook-approval tokens.</summary>
public sealed record Nonce
{
    /// <summary>Gets the opaque random value (base64-encoded, &gt;= 32 bytes of entropy).</summary>
    public required string Value { get; init; }

    /// <summary>Gets the UTC time at which the nonce was issued.</summary>
    public required DateTimeOffset IssuedAt { get; init; }

    /// <summary>Gets the UTC time at which the nonce rotates out.</summary>
    public required DateTimeOffset RotatesAt { get; init; }
}
