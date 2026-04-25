// <copyright file="FileKeyMaterialProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using AiOrchestrator.Abstractions.Io;
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
    /// <param name="fs">File system abstraction for reading key material.</param>
    public FileKeyMaterialProvider(AbsolutePath keyRoot, string activeKeyId, IFileSystem fs)
    {
        ArgumentException.ThrowIfNullOrEmpty(activeKeyId);
        ArgumentNullException.ThrowIfNull(fs);
        this.ActiveKeyId = activeKeyId;

        var privPath = new AbsolutePath(Path.Combine(keyRoot.Value, $"{activeKeyId}.priv"));
        var pubPath = new AbsolutePath(Path.Combine(keyRoot.Value, $"{activeKeyId}.pub"));

        this.activePrivate = fs.ReadAllBytesAsync(privPath, CancellationToken.None).GetAwaiter().GetResult();
        this.activePublic = fs.ReadAllBytesAsync(pubPath, CancellationToken.None).GetAwaiter().GetResult();
        this.historicalPublic = new(StringComparer.Ordinal)
        {
            [activeKeyId] = this.activePublic,
        };

        var historyDir = new AbsolutePath(Path.Combine(keyRoot.Value, "history"));
        if (fs.DirectoryExistsAsync(historyDir, CancellationToken.None).GetAwaiter().GetResult())
        {
            var enumerator = fs.EnumerateFilesAsync(historyDir, "*.pub", CancellationToken.None).GetAsyncEnumerator(CancellationToken.None);
            try
            {
                while (enumerator.MoveNextAsync().GetAwaiter().GetResult())
                {
                    var f = enumerator.Current;
                    var id = Path.GetFileNameWithoutExtension(f.Value);
                    this.historicalPublic[id] = fs.ReadAllBytesAsync(f, CancellationToken.None).GetAwaiter().GetResult();
                }
            }
            finally
            {
                enumerator.DisposeAsync().GetAwaiter().GetResult();
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
