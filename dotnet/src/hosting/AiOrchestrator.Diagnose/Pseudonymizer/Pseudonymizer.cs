// <copyright file="Pseudonymizer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Diagnose.Pseudonymizer;

/// <summary>
/// Produces stable pseudonyms of the form <c>{kind}-{hex4}</c> (DIAG-RECIP-1).
/// Pseudonyms are derived deterministically from the input + a per-session salt so that
/// the same value within one bundle always maps to the same pseudonym, but values
/// across bundles are not linkable when salts differ.
/// </summary>
internal sealed class Pseudonymizer : IPseudonymizer
{
    private readonly byte[] salt;
    private readonly MappingTable table;

    public Pseudonymizer(byte[] salt, MappingTable table)
    {
        ArgumentNullException.ThrowIfNull(salt);
        ArgumentNullException.ThrowIfNull(table);
        this.salt = salt;
        this.table = table;
    }

    /// <inheritdoc />
    public ValueTask<string> PseudonymizeAsync(string original, PseudonymKind kind, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(original);
        ct.ThrowIfCancellationRequested();

        if (this.table.TryGetForward(original, out var cached) && cached != null)
        {
            return ValueTask.FromResult(cached);
        }

        var prefix = Prefix(kind);
        var token = HashToken(original, this.salt);
        var pseudonym = $"{prefix}-{token}";
        this.table.Record(original, pseudonym);
        return ValueTask.FromResult(pseudonym);
    }

    /// <inheritdoc />
    public ValueTask<string?> ReverseAsync(string pseudonym, string recipientPubKeyFingerprint, byte[] privateKey, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(pseudonym);
        ArgumentNullException.ThrowIfNull(privateKey);
        ct.ThrowIfCancellationRequested();

        var reverse = this.table.GetReverse();
        return ValueTask.FromResult(reverse.TryGetValue(pseudonym, out var v) ? v : null);
    }

    internal static string HashToken(string original, byte[] salt)
    {
        Span<byte> hashBuf = stackalloc byte[32];
        using (var hmac = new HMACSHA256(salt))
        {
            var bytes = Encoding.UTF8.GetBytes(original);
            hmac.TryComputeHash(bytes, hashBuf, out _);
        }

        // First 2 bytes → 4 hex chars, uppercase.
        return $"{hashBuf[0]:X2}{hashBuf[1]:X2}";
    }

    internal static string Prefix(PseudonymKind kind) => kind switch
    {
        PseudonymKind.UserName => "user",
        PseudonymKind.Hostname => "host",
        PseudonymKind.RepoUrl => "repo",
        PseudonymKind.FilePath => "path",
        PseudonymKind.EmailAddress => "email",
        PseudonymKind.IpAddress => "ip",
        _ => "id",
    };
}
