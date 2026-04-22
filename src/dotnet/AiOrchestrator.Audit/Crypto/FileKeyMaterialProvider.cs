// <copyright file="FileKeyMaterialProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Audit.Crypto;

/// <summary>
/// Default <see cref="IKeyMaterialProvider"/> that loads the active key pair (and optional
/// historical public keys) from a directory on disk.
/// </summary>
public sealed class FileKeyMaterialProvider : IKeyMaterialProvider
{
    private readonly byte[] activePrivate;
    private readonly byte[] activePublic;
    private readonly Dictionary<string, byte[]> historicalPublic;

    /// <summary>Initializes a new <see cref="FileKeyMaterialProvider"/> from a directory layout.</summary>
    /// <param name="keyRoot">Directory containing <c>{keyId}.priv</c>, <c>{keyId}.pub</c>, and optional <c>history/{keyId}.pub</c> entries.</param>
    /// <param name="activeKeyId">The identifier of the active key.</param>
    public FileKeyMaterialProvider(AbsolutePath keyRoot, string activeKeyId)
    {
        ArgumentException.ThrowIfNullOrEmpty(activeKeyId);
        this.ActiveKeyId = activeKeyId;

        var privPath = Path.Combine(keyRoot.Value, $"{activeKeyId}.priv");
        var pubPath = Path.Combine(keyRoot.Value, $"{activeKeyId}.pub");

        this.activePrivate = File.ReadAllBytes(privPath);
        this.activePublic = File.ReadAllBytes(pubPath);
        this.historicalPublic = new(StringComparer.Ordinal)
        {
            [activeKeyId] = this.activePublic,
        };

        var historyDir = Path.Combine(keyRoot.Value, "history");
        if (Directory.Exists(historyDir))
        {
            foreach (var f in Directory.EnumerateFiles(historyDir, "*.pub"))
            {
                var id = Path.GetFileNameWithoutExtension(f);
                this.historicalPublic[id] = File.ReadAllBytes(f);
            }
        }
    }

    /// <inheritdoc />
    public string ActiveKeyId { get; }

    /// <inheritdoc />
    public ReadOnlyMemory<byte> GetActivePrivateKey() => this.activePrivate;

    /// <inheritdoc />
    public ReadOnlyMemory<byte> GetActivePublicKey() => this.activePublic;

    /// <inheritdoc />
    public ReadOnlyMemory<byte>? TryGetPublicKey(string keyId)
    {
        if (string.IsNullOrEmpty(keyId))
        {
            return null;
        }

        return this.historicalPublic.TryGetValue(keyId, out var pk) ? pk : null;
    }
}
