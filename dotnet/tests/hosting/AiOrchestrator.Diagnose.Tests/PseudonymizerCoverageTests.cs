// <copyright file="PseudonymizerCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Diagnose.Pseudonymizer;
using Xunit;

namespace AiOrchestrator.Diagnose.Tests;

public sealed class PseudonymizerCoverageTests
{
    // ─────────── MappingTable ───────────

    [Fact]
    public void MappingTable_TryGetForward_Miss_ReturnsFalse()
    {
        var table = new MappingTable();
        var found = table.TryGetForward("unknown", out var pseudonym);
        Assert.False(found);
        Assert.Null(pseudonym);
    }

    [Fact]
    public void MappingTable_Record_ThenTryGetForward_ReturnsTrue()
    {
        var table = new MappingTable();
        table.Record("alice@example.com", "email-A1B2");
        var found = table.TryGetForward("alice@example.com", out var pseudonym);
        Assert.True(found);
        Assert.Equal("email-A1B2", pseudonym);
    }

    [Fact]
    public void MappingTable_Record_OverwritesPreviousMapping()
    {
        var table = new MappingTable();
        table.Record("key", "val1");
        table.Record("key", "val2");
        table.TryGetForward("key", out var pseudonym);
        Assert.Equal("val2", pseudonym);
    }

    [Fact]
    public void MappingTable_GetSortedForward_ReturnsSortedKeys()
    {
        var table = new MappingTable();
        table.Record("z-item", "pseudo-z");
        table.Record("a-item", "pseudo-a");
        table.Record("m-item", "pseudo-m");

        var sorted = table.GetSortedForward();
        var keys = new List<string>(sorted.Keys);
        Assert.Equal("a-item", keys[0]);
        Assert.Equal("m-item", keys[1]);
        Assert.Equal("z-item", keys[2]);
    }

    [Fact]
    public void MappingTable_GetReverse_ReturnsReverseMappings()
    {
        var table = new MappingTable();
        table.Record("original", "pseudo");

        var reverse = table.GetReverse();
        Assert.True(reverse.ContainsKey("pseudo"));
        Assert.Equal("original", reverse["pseudo"]);
    }

    [Fact]
    public void MappingTable_Count_ReflectsRecordedEntries()
    {
        var table = new MappingTable();
        Assert.Equal(0, table.Count);

        table.Record("a", "pa");
        Assert.Equal(1, table.Count);

        table.Record("b", "pb");
        Assert.Equal(2, table.Count);
    }

    [Fact]
    public void MappingTable_Count_DoesNotDoubleCountOverwrite()
    {
        var table = new MappingTable();
        table.Record("x", "px1");
        table.Record("x", "px2");
        Assert.Equal(1, table.Count);
    }

    // ─────────── Pseudonymizer ───────────

    [Fact]
    public async Task Pseudonymizer_PseudonymizeAsync_NullOriginal_Throws()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await pseudonymizer.PseudonymizeAsync(null!, PseudonymKind.UserName, CancellationToken.None));
    }

    [Fact]
    public async Task Pseudonymizer_PseudonymizeAsync_ReturnsCachedOnSecondCall()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        var first = await pseudonymizer.PseudonymizeAsync("alice", PseudonymKind.UserName, CancellationToken.None);
        var second = await pseudonymizer.PseudonymizeAsync("alice", PseudonymKind.UserName, CancellationToken.None);
        Assert.Equal(first, second);
    }

    [Fact]
    public async Task Pseudonymizer_PseudonymizeAsync_FormatMatchesKind()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        var result = await pseudonymizer.PseudonymizeAsync("user1", PseudonymKind.UserName, CancellationToken.None);
        Assert.StartsWith("user-", result);
        Assert.Matches(@"^user-[0-9A-F]{4}$", result);
    }

    [Fact]
    public async Task Pseudonymizer_PseudonymizeAsync_DifferentKinds_DifferentPrefixes()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        var host = await pseudonymizer.PseudonymizeAsync("myhost", PseudonymKind.Hostname, CancellationToken.None);
        Assert.StartsWith("host-", host);

        var ip = await pseudonymizer.PseudonymizeAsync("10.0.0.1", PseudonymKind.IpAddress, CancellationToken.None);
        Assert.StartsWith("ip-", ip);
    }

    [Fact]
    public async Task Pseudonymizer_ReverseAsync_KnownPseudonym_ReturnsOriginal()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        var pseudonym = await pseudonymizer.PseudonymizeAsync("secret@corp.com", PseudonymKind.EmailAddress, CancellationToken.None);
        var reversed = await pseudonymizer.ReverseAsync(pseudonym, "fp", new byte[32], CancellationToken.None);
        Assert.Equal("secret@corp.com", reversed);
    }

    [Fact]
    public async Task Pseudonymizer_ReverseAsync_UnknownPseudonym_ReturnsNull()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        var result = await pseudonymizer.ReverseAsync("email-FFFF", "fp", new byte[32], CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task Pseudonymizer_ReverseAsync_NullPseudonym_Throws()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        await Assert.ThrowsAnyAsync<ArgumentException>(async () =>
            await pseudonymizer.ReverseAsync(null!, "fp", new byte[32], CancellationToken.None));
    }

    [Fact]
    public async Task Pseudonymizer_ReverseAsync_NullPrivateKey_Throws()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);

        await Assert.ThrowsAsync<ArgumentNullException>(async () =>
            await pseudonymizer.ReverseAsync("email-AAAA", "fp", null!, CancellationToken.None));
    }

    [Theory]
    [InlineData(PseudonymKind.UserName, "user")]
    [InlineData(PseudonymKind.Hostname, "host")]
    [InlineData(PseudonymKind.RepoUrl, "repo")]
    [InlineData(PseudonymKind.FilePath, "path")]
    [InlineData(PseudonymKind.EmailAddress, "email")]
    [InlineData(PseudonymKind.IpAddress, "ip")]
    public void Pseudonymizer_Prefix_AllKinds(PseudonymKind kind, string expected)
    {
        Assert.Equal(expected, Pseudonymizer.Pseudonymizer.Prefix(kind));
    }

    [Fact]
    public void Pseudonymizer_Prefix_UnknownKind_ReturnsId()
    {
        Assert.Equal("id", Pseudonymizer.Pseudonymizer.Prefix((PseudonymKind)999));
    }

    [Fact]
    public void Pseudonymizer_HashToken_Deterministic()
    {
        var salt = new byte[] { 1, 2, 3, 4 };
        var a = Pseudonymizer.Pseudonymizer.HashToken("test", salt);
        var b = Pseudonymizer.Pseudonymizer.HashToken("test", salt);
        Assert.Equal(a, b);
        Assert.Equal(4, a.Length);
    }

    [Fact]
    public void Pseudonymizer_HashToken_DifferentInput_DifferentResult()
    {
        var salt = new byte[] { 5, 6, 7, 8 };
        var a = Pseudonymizer.Pseudonymizer.HashToken("alice", salt);
        var b = Pseudonymizer.Pseudonymizer.HashToken("bob", salt);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Pseudonymizer_NullSalt_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new Pseudonymizer.Pseudonymizer(null!, new MappingTable()));
    }

    [Fact]
    public void Pseudonymizer_NullTable_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new Pseudonymizer.Pseudonymizer(new byte[32], null!));
    }

    // ─────────── MappingTableEncryptor ───────────

    [Fact]
    public void MappingTableEncryptor_RoundTrip()
    {
        using var rsa = RSA.Create(2048);
        var pub = rsa.ExportSubjectPublicKeyInfo();
        var priv = rsa.ExportPkcs8PrivateKey();
        var fp = "test-fp";
        var mapping = new Dictionary<string, string> { ["alice"] = "user-AB12", ["bob"] = "user-CD34" };

        var encrypted = MappingTableEncryptor.Encrypt(mapping, fp, pub);
        var decrypted = MappingTableEncryptor.TryDecrypt(encrypted, fp, priv);

        Assert.NotNull(decrypted);
        Assert.Equal("user-AB12", decrypted!["alice"]);
        Assert.Equal("user-CD34", decrypted["bob"]);
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_WrongFingerprint_ReturnsNull()
    {
        using var rsa = RSA.Create(2048);
        var pub = rsa.ExportSubjectPublicKeyInfo();
        var priv = rsa.ExportPkcs8PrivateKey();
        var mapping = new Dictionary<string, string> { ["k"] = "v" };

        var encrypted = MappingTableEncryptor.Encrypt(mapping, "correct-fp", pub);
        var result = MappingTableEncryptor.TryDecrypt(encrypted, "wrong-fp", priv);
        Assert.Null(result);
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_WrongKey_ReturnsNull()
    {
        using var rsa = RSA.Create(2048);
        var pub = rsa.ExportSubjectPublicKeyInfo();
        var mapping = new Dictionary<string, string> { ["k"] = "v" };

        var encrypted = MappingTableEncryptor.Encrypt(mapping, "fp", pub);

        using var otherRsa = RSA.Create(2048);
        var wrongPriv = otherRsa.ExportPkcs8PrivateKey();
        var result = MappingTableEncryptor.TryDecrypt(encrypted, "fp", wrongPriv);
        Assert.Null(result);
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_TruncatedPayload_ReturnsNull()
    {
        var result = MappingTableEncryptor.TryDecrypt(new byte[] { 0, 1, 2 }, "fp", new byte[1]);
        Assert.Null(result);
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_WrongMagic_ReturnsNull()
    {
        var payload = new byte[] { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0 };
        var result = MappingTableEncryptor.TryDecrypt(payload, "fp", new byte[32]);
        Assert.Null(result);
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_CorruptedCipher_ReturnsNull()
    {
        using var rsa = RSA.Create(2048);
        var pub = rsa.ExportSubjectPublicKeyInfo();
        var priv = rsa.ExportPkcs8PrivateKey();
        var mapping = new Dictionary<string, string> { ["k"] = "v" };

        var encrypted = MappingTableEncryptor.Encrypt(mapping, "fp", pub);

        // Corrupt a byte near the end (in the cipher region)
        encrypted[encrypted.Length - 5] ^= 0xFF;
        var result = MappingTableEncryptor.TryDecrypt(encrypted, "fp", priv);
        Assert.Null(result);
    }

    [Fact]
    public void MappingTableEncryptor_Encrypt_NullMapping_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            MappingTableEncryptor.Encrypt(null!, "fp", new byte[1]));
    }

    [Fact]
    public void MappingTableEncryptor_Encrypt_NullFingerprint_Throws()
    {
        Assert.ThrowsAny<ArgumentException>(() =>
            MappingTableEncryptor.Encrypt(new Dictionary<string, string>(), null!, new byte[1]));
    }

    [Fact]
    public void MappingTableEncryptor_Encrypt_NullPublicKey_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            MappingTableEncryptor.Encrypt(new Dictionary<string, string>(), "fp", null!));
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_NullPayload_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            MappingTableEncryptor.TryDecrypt(null!, "fp", new byte[1]));
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_NullExpectedFingerprint_Throws()
    {
        Assert.ThrowsAny<ArgumentException>(() =>
            MappingTableEncryptor.TryDecrypt(new byte[1], null!, new byte[1]));
    }

    [Fact]
    public void MappingTableEncryptor_TryDecrypt_NullPrivateKey_Throws()
    {
        Assert.Throws<ArgumentNullException>(() =>
            MappingTableEncryptor.TryDecrypt(new byte[1], "fp", null!));
    }

    [Fact]
    public async Task Pseudonymizer_PseudonymizeAsync_CancelledToken_Throws()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);
        var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await pseudonymizer.PseudonymizeAsync("val", PseudonymKind.UserName, cts.Token));
    }

    [Fact]
    public async Task Pseudonymizer_ReverseAsync_CancelledToken_Throws()
    {
        var salt = new byte[32];
        RandomNumberGenerator.Fill(salt);
        var table = new MappingTable();
        var pseudonymizer = new Pseudonymizer.Pseudonymizer(salt, table);
        var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await pseudonymizer.ReverseAsync("email-AAAA", "fp", new byte[32], cts.Token));
    }
}
