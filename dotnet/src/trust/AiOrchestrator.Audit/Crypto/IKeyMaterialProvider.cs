// <copyright file="IKeyMaterialProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit.Crypto;

/// <summary>
/// Supplies the active Ed25519 signing key plus historical public keys to the audit log.
/// Production implementations source private keys from disk; tests use in-memory keys.
/// </summary>
public interface IKeyMaterialProvider
{
    /// <summary>Gets the human-readable identifier of the currently active signing key.</summary>
    string ActiveKeyId { get; }

    /// <summary>Reads the active 32-byte Ed25519 private seed.</summary>
    /// <returns>The active 32-byte private key.</returns>
    ReadOnlyMemory<byte> GetActivePrivateKey();

    /// <summary>Reads the active 32-byte Ed25519 public key.</summary>
    /// <returns>The active 32-byte public key.</returns>
    ReadOnlyMemory<byte> GetActivePublicKey();

    /// <summary>Reads a historical public key by identifier, or <see langword="null"/> if unknown.</summary>
    /// <param name="keyId">The key identifier to look up.</param>
    /// <returns>The 32-byte public key, or <see langword="null"/>.</returns>
    ReadOnlyMemory<byte>? TryGetPublicKey(string keyId);
}
