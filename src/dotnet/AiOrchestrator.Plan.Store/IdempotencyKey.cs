// <copyright file="IdempotencyKey.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Opaque idempotency key per RW-2-IDEM. Equality is value-based on the underlying string.
/// Use <see cref="FromContent(ReadOnlySpan{byte})"/> to derive a deterministic key from canonical content.
/// </summary>
public readonly record struct IdempotencyKey(string Value)
{
    /// <summary>Computes a deterministic idempotency key as the hex-encoded SHA-256 of <paramref name="content"/>.</summary>
    /// <param name="content">The canonical payload bytes (RW-2-IDEM-3).</param>
    /// <returns>An idempotency key that is identical across processes for identical content.</returns>
    public static IdempotencyKey FromContent(ReadOnlySpan<byte> content)
    {
        Span<byte> hash = stackalloc byte[32];
        _ = SHA256.HashData(content, hash);
        return new IdempotencyKey(Convert.ToHexString(hash));
    }

    /// <summary>Wraps a <see cref="Guid"/> as an idempotency key.</summary>
    /// <param name="value">The guid value.</param>
    /// <returns>An idempotency key whose <see cref="Value"/> is the guid's canonical "N" form.</returns>
    public static IdempotencyKey FromGuid(Guid value) => new(value.ToString("N"));

    /// <inheritdoc />
    public override string ToString() => this.Value ?? string.Empty;
}
