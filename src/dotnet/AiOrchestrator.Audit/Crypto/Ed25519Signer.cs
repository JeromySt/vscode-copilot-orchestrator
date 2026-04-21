// <copyright file="Ed25519Signer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using Org.BouncyCastle.Math.EC.Rfc8032;

namespace AiOrchestrator.Audit.Crypto;

/// <summary>
/// Wraps Ed25519 sign/verify (RFC 8032) using BouncyCastle's deterministic implementation
/// (INV-2, INV-9). The daemon path NEVER calls <see cref="Sign"/> with a build-key (INV-6).
/// </summary>
public sealed class Ed25519Signer
{
    /// <summary>The size of an Ed25519 private key, in bytes.</summary>
    public const int PrivateKeySize = 32;

    /// <summary>The size of an Ed25519 public key, in bytes.</summary>
    public const int PublicKeySize = 32;

    /// <summary>The size of an Ed25519 signature, in bytes.</summary>
    public const int SignatureSize = 64;

    /// <summary>Signs <paramref name="message"/> with the supplied 32-byte Ed25519 private seed.</summary>
    /// <param name="message">The bytes to sign (typically a segment hash).</param>
    /// <param name="privateKey">The 32-byte Ed25519 private seed.</param>
    /// <returns>A 64-byte detached Ed25519 signature.</returns>
    public byte[] Sign(byte[] message, ReadOnlySpan<byte> privateKey)
    {
        ArgumentNullException.ThrowIfNull(message);
        if (privateKey.Length != PrivateKeySize)
        {
            throw new ArgumentException($"privateKey must be exactly {PrivateKeySize} bytes.", nameof(privateKey));
        }

        var sig = new byte[SignatureSize];
        Ed25519.Sign(privateKey.ToArray(), 0, message, 0, message.Length, sig, 0);
        return sig;
    }

    /// <summary>Verifies an Ed25519 signature.</summary>
    /// <param name="message">The signed bytes.</param>
    /// <param name="signature">The 64-byte detached signature.</param>
    /// <param name="publicKey">The 32-byte Ed25519 public key.</param>
    /// <returns><see langword="true"/> if the signature is valid; otherwise <see langword="false"/>.</returns>
    public bool Verify(byte[] message, byte[] signature, ReadOnlySpan<byte> publicKey)
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(signature);
        if (signature.Length != SignatureSize || publicKey.Length != PublicKeySize)
        {
            return false;
        }

        return Ed25519.Verify(signature, 0, publicKey.ToArray(), 0, message, 0, message.Length);
    }

    /// <summary>Derives the public key matching the supplied 32-byte private seed.</summary>
    /// <param name="privateKey">The 32-byte Ed25519 private seed.</param>
    /// <returns>The 32-byte public key.</returns>
    public static byte[] DerivePublicKey(ReadOnlySpan<byte> privateKey)
    {
        if (privateKey.Length != PrivateKeySize)
        {
            throw new ArgumentException($"privateKey must be exactly {PrivateKeySize} bytes.", nameof(privateKey));
        }

        var pub = new byte[PublicKeySize];
        Ed25519.GeneratePublicKey(privateKey.ToArray(), 0, pub, 0);
        return pub;
    }
}
