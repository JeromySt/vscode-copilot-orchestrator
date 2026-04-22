// <copyright file="EcdsaSigner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;

namespace AiOrchestrator.Audit.Crypto;

/// <summary>
/// ECDSA P-256 sign/verify using the .NET BCL (zero third-party dependencies).
/// The hash algorithm is configurable (default SHA-256; use SHA-384+ for CRA compliance).
/// (INV-2, INV-9). The daemon path NEVER calls <see cref="Sign"/> with a build-key (INV-6).
/// </summary>
public sealed class EcdsaSigner
{
    /// <summary>The hash algorithm used for signing and verification.</summary>
    public HashAlgorithmName HashAlgorithm { get; }

    /// <summary>Initializes a new <see cref="EcdsaSigner"/> with the specified hash algorithm.</summary>
    /// <param name="hashAlgorithm">The hash algorithm to use. Defaults to <see cref="HashAlgorithmName.SHA256"/>.</param>
    public EcdsaSigner(HashAlgorithmName? hashAlgorithm = null)
    {
        HashAlgorithm = hashAlgorithm ?? HashAlgorithmName.SHA256;
    }

    /// <summary>Signs <paramref name="message"/> with the supplied ECDSA P-256 private key (PKCS#8 DER).</summary>
    /// <param name="message">The bytes to sign (typically a segment hash).</param>
    /// <param name="privateKey">The ECDSA P-256 private key in PKCS#8 DER format.</param>
    /// <returns>A DER-encoded ECDSA signature.</returns>
    public byte[] Sign(byte[] message, ReadOnlySpan<byte> privateKey)
    {
        ArgumentNullException.ThrowIfNull(message);
        using var ecdsa = ECDsa.Create();
        ecdsa.ImportPkcs8PrivateKey(privateKey, out _);
        return ecdsa.SignData(message, HashAlgorithm);
    }

    /// <summary>Verifies an ECDSA P-256 signature.</summary>
    /// <param name="message">The signed bytes.</param>
    /// <param name="signature">The DER-encoded signature.</param>
    /// <param name="publicKey">The public key in SubjectPublicKeyInfo DER format.</param>
    /// <returns><see langword="true"/> if the signature is valid; otherwise <see langword="false"/>.</returns>
    public bool Verify(byte[] message, byte[] signature, ReadOnlySpan<byte> publicKey)
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(signature);
        try
        {
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(publicKey, out _);
            return ecdsa.VerifyData(message, signature, HashAlgorithm);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    /// <summary>Generates a new ECDSA P-256 key pair.</summary>
    /// <param name="privateKey">Receives the private key in PKCS#8 DER format.</param>
    /// <param name="publicKey">Receives the public key in SubjectPublicKeyInfo DER format.</param>
    public static void GenerateKeyPair(out byte[] privateKey, out byte[] publicKey)
    {
        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        privateKey = ecdsa.ExportPkcs8PrivateKey();
        publicKey = ecdsa.ExportSubjectPublicKeyInfo();
    }

    /// <summary>Derives the public key matching the supplied private key.</summary>
    /// <param name="privateKey">The ECDSA P-256 private key in PKCS#8 DER format.</param>
    /// <returns>The public key in SubjectPublicKeyInfo DER format.</returns>
    public static byte[] DerivePublicKey(ReadOnlySpan<byte> privateKey)
    {
        using var ecdsa = ECDsa.Create();
        ecdsa.ImportPkcs8PrivateKey(privateKey, out _);
        return ecdsa.ExportSubjectPublicKeyInfo();
    }
}
