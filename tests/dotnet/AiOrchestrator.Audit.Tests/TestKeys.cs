// <copyright file="TestKeys.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Audit.Crypto;
using Org.BouncyCastle.Math.EC.Rfc8032;
using Org.BouncyCastle.Security;

namespace AiOrchestrator.Audit.Tests;

internal static class TestKeys
{
    private static readonly SecureRandom Rng = new();

    public static (byte[] Priv, byte[] Pub) Generate()
    {
        var priv = new byte[Ed25519Signer.PrivateKeySize];
        Rng.NextBytes(priv);
        var pub = Ed25519Signer.DerivePublicKey(priv);
        return (priv, pub);
    }
}

internal sealed class StaticKeyMaterialProvider : IKeyMaterialProvider
{
    private readonly byte[] priv;
    private readonly byte[] pub;
    private readonly System.Collections.Generic.Dictionary<string, byte[]> history = new(StringComparer.Ordinal);

    public StaticKeyMaterialProvider(string keyId, byte[] priv, byte[] pub)
    {
        this.ActiveKeyId = keyId;
        this.priv = priv;
        this.pub = pub;
        this.history[keyId] = pub;
    }

    public string ActiveKeyId { get; }

    public ReadOnlyMemory<byte> GetActivePrivateKey() => this.priv;

    public ReadOnlyMemory<byte> GetActivePublicKey() => this.pub;

    public ReadOnlyMemory<byte>? TryGetPublicKey(string keyId) =>
        this.history.TryGetValue(keyId, out var v) ? v : null;

    public void AddHistorical(string keyId, byte[] pubKey) => this.history[keyId] = pubKey;
}
