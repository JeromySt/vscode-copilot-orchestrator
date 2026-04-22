// <copyright file="TestKeys.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Audit.Crypto;

namespace AiOrchestrator.Audit.Tests;

internal static class TestKeys
{
    public static (byte[] Priv, byte[] Pub) Generate()
    {
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
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
