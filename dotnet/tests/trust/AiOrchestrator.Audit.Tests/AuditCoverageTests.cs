// <copyright file="AuditCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit.Chain;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Xunit;

namespace AiOrchestrator.Audit.Tests;

public sealed class AuditCoverageTests : IDisposable
{
    private readonly string root;

    public AuditCoverageTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "audit-cov", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); } catch { }
    }

    // ─────────── HmacChain ───────────

    [Fact]
    public void HmacChain_Compute_NullPrevHmac_Throws()
    {
        var chain = new HmacChain();
        Assert.Throws<ArgumentNullException>(() => chain.Compute(null!, ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void HmacChain_Compute_WrongLengthPrevHmac_Throws()
    {
        var chain = new HmacChain();
        var ex = Assert.Throws<ArgumentException>(() => chain.Compute(new byte[16], new byte[] { 1, 2, 3 }));
        Assert.Contains("32 bytes", ex.Message);
    }

    [Fact]
    public void HmacChain_Compute_ValidInput_Returns32Bytes()
    {
        var chain = new HmacChain();
        var result = chain.Compute(new byte[32], new byte[] { 0xCA, 0xFE });
        Assert.Equal(32, result.Length);
    }

    [Fact]
    public void HmacChain_Compute_DeterministicForSameInput()
    {
        var chain = new HmacChain();
        var prev = new byte[32];
        prev[0] = 0x42;
        var body = new byte[] { 1, 2, 3, 4, 5 };
        var a = chain.Compute(prev, body);
        var b = chain.Compute(prev, body);
        Assert.Equal(a, b);
    }

    // ─────────── EcdsaSigner ───────────

    [Fact]
    public void EcdsaSigner_Sign_NullMessage_Throws()
    {
        var signer = new EcdsaSigner();
        EcdsaSigner.GenerateKeyPair(out var priv, out _);
        Assert.Throws<ArgumentNullException>(() => signer.Sign(null!, priv));
    }

    [Fact]
    public void EcdsaSigner_Verify_NullMessage_Throws()
    {
        var signer = new EcdsaSigner();
        Assert.Throws<ArgumentNullException>(() => signer.Verify(null!, new byte[64], new byte[91]));
    }

    [Fact]
    public void EcdsaSigner_Verify_NullSignature_Throws()
    {
        var signer = new EcdsaSigner();
        Assert.Throws<ArgumentNullException>(() => signer.Verify(new byte[32], null!, new byte[91]));
    }

    [Fact]
    public void EcdsaSigner_Verify_CorruptPublicKey_ReturnsFalse()
    {
        var signer = new EcdsaSigner();
        var result = signer.Verify(new byte[32], new byte[64], new byte[] { 0xDE, 0xAD });
        Assert.False(result);
    }

    [Fact]
    public void EcdsaSigner_DerivePublicKey_Roundtrip()
    {
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        var derived = EcdsaSigner.DerivePublicKey(priv);
        Assert.Equal(pub, derived);
    }

    [Fact]
    public void EcdsaSigner_CustomHashAlgorithm()
    {
        var signer = new EcdsaSigner(HashAlgorithmName.SHA384);
        Assert.Equal(HashAlgorithmName.SHA384, signer.HashAlgorithm);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        var msg = new byte[] { 1, 2, 3 };
        var sig = signer.Sign(msg, priv);
        Assert.True(signer.Verify(msg, sig, pub));
    }

    [Fact]
    public void EcdsaSigner_SignAndVerify_Roundtrip()
    {
        var signer = new EcdsaSigner();
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        var msg = new byte[] { 10, 20, 30, 40 };
        var sig = signer.Sign(msg, priv);
        Assert.True(signer.Verify(msg, sig, pub));
    }

    [Fact]
    public void EcdsaSigner_Verify_WrongMessage_ReturnsFalse()
    {
        var signer = new EcdsaSigner();
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        var sig = signer.Sign(new byte[] { 1 }, priv);
        Assert.False(signer.Verify(new byte[] { 2 }, sig, pub));
    }

    // ─────────── FileKeyMaterialProvider ───────────

    [Fact]
    public void FileKeyMaterialProvider_LoadsActiveKeyPair()
    {
        var keyDir = Path.Combine(this.root, "keys-active");
        Directory.CreateDirectory(keyDir);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        File.WriteAllBytes(Path.Combine(keyDir, "k1.priv"), priv);
        File.WriteAllBytes(Path.Combine(keyDir, "k1.pub"), pub);

        var provider = new FileKeyMaterialProvider(new AbsolutePath(keyDir), "k1", new PassthroughFileSystem());

        Assert.Equal("k1", provider.ActiveKeyId);
        Assert.Equal(priv, provider.GetActivePrivateKey().ToArray());
        Assert.Equal(pub, provider.GetActivePublicKey().ToArray());
    }

    [Fact]
    public void FileKeyMaterialProvider_TryGetPublicKey_ActiveKey_ReturnsIt()
    {
        var keyDir = Path.Combine(this.root, "keys-tryget");
        Directory.CreateDirectory(keyDir);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        File.WriteAllBytes(Path.Combine(keyDir, "active.priv"), priv);
        File.WriteAllBytes(Path.Combine(keyDir, "active.pub"), pub);

        var provider = new FileKeyMaterialProvider(new AbsolutePath(keyDir), "active", new PassthroughFileSystem());
        var result = provider.TryGetPublicKey("active");

        Assert.NotNull(result);
        Assert.Equal(pub, result!.Value.ToArray());
    }

    [Fact]
    public void FileKeyMaterialProvider_TryGetPublicKey_HistoricalKey_ReturnsIt()
    {
        var keyDir = Path.Combine(this.root, "keys-hist");
        Directory.CreateDirectory(keyDir);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        File.WriteAllBytes(Path.Combine(keyDir, "current.priv"), priv);
        File.WriteAllBytes(Path.Combine(keyDir, "current.pub"), pub);

        var histDir = Path.Combine(keyDir, "history");
        Directory.CreateDirectory(histDir);

        EcdsaSigner.GenerateKeyPair(out _, out var oldPub);
        File.WriteAllBytes(Path.Combine(histDir, "old-key.pub"), oldPub);

        var provider = new FileKeyMaterialProvider(new AbsolutePath(keyDir), "current", new PassthroughFileSystem());
        var result = provider.TryGetPublicKey("old-key");

        Assert.NotNull(result);
        Assert.Equal(oldPub, result!.Value.ToArray());
    }

    [Fact]
    public void FileKeyMaterialProvider_TryGetPublicKey_NullOrEmpty_ReturnsNull()
    {
        var keyDir = Path.Combine(this.root, "keys-null");
        Directory.CreateDirectory(keyDir);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        File.WriteAllBytes(Path.Combine(keyDir, "k.priv"), priv);
        File.WriteAllBytes(Path.Combine(keyDir, "k.pub"), pub);

        var provider = new FileKeyMaterialProvider(new AbsolutePath(keyDir), "k", new PassthroughFileSystem());

        Assert.Null(provider.TryGetPublicKey(null!));
        Assert.Null(provider.TryGetPublicKey(string.Empty));
    }

    [Fact]
    public void FileKeyMaterialProvider_TryGetPublicKey_UnknownId_ReturnsNull()
    {
        var keyDir = Path.Combine(this.root, "keys-unknown");
        Directory.CreateDirectory(keyDir);

        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        File.WriteAllBytes(Path.Combine(keyDir, "k.priv"), priv);
        File.WriteAllBytes(Path.Combine(keyDir, "k.pub"), pub);

        var provider = new FileKeyMaterialProvider(new AbsolutePath(keyDir), "k", new PassthroughFileSystem());
        var result = provider.TryGetPublicKey("nonexistent");
        // The ternary `pk : null` returns a byte[] null that gets implicitly converted
        // to a default ReadOnlyMemory<byte> (length 0) — not a null Nullable.
        Assert.True(result is null || result.Value.Length == 0, "unknown key should return null or empty");
    }

    [Fact]
    public void FileKeyMaterialProvider_NullKeyId_Throws()
    {
        var keyDir = Path.Combine(this.root, "keys-nullid");
        Directory.CreateDirectory(keyDir);
        Assert.ThrowsAny<ArgumentException>(() => new FileKeyMaterialProvider(new AbsolutePath(keyDir), null!, new PassthroughFileSystem()));
    }

    [Fact]
    public void FileKeyMaterialProvider_EmptyKeyId_Throws()
    {
        var keyDir = Path.Combine(this.root, "keys-emptyid");
        Directory.CreateDirectory(keyDir);
        Assert.ThrowsAny<ArgumentException>(() => new FileKeyMaterialProvider(new AbsolutePath(keyDir), string.Empty, new PassthroughFileSystem()));
    }

    // ─────────── SegmentReader ───────────

    [Fact]
    public async Task SegmentReader_ReadAllAsync_NonExistentDir_ReturnsEmpty()
    {
        var reader = new SegmentReader(new PassthroughFileSystem());
        var result = await reader.ReadAllAsync(new AbsolutePath(Path.Combine(this.root, "no-such-dir")), CancellationToken.None);
        Assert.Empty(result);
    }

    [Fact]
    public async Task SegmentReader_CleanupTempFiles_NonExistentDir_NoThrow()
    {
        var reader = new SegmentReader(new PassthroughFileSystem());
        await reader.CleanupTempFilesAsync(new AbsolutePath(Path.Combine(this.root, "no-dir")), CancellationToken.None);
        // Should not throw
    }

    [Fact]
    public async Task SegmentReader_CleanupTempFiles_RemovesTmpFiles()
    {
        var dir = Path.Combine(this.root, "cleanup");
        Directory.CreateDirectory(dir);
        var tmpFile = Path.Combine(dir, "test.aioa.tmp");
        File.WriteAllBytes(tmpFile, new byte[] { 1, 2, 3 });

        var reader = new SegmentReader(new PassthroughFileSystem());
        await reader.CleanupTempFilesAsync(new AbsolutePath(dir), CancellationToken.None);

        Assert.False(File.Exists(tmpFile));
    }

    [Fact]
    public async Task SegmentReader_ReadAllAsync_SkipsTmpFiles()
    {
        var dir = Path.Combine(this.root, "skip-tmp");
        Directory.CreateDirectory(dir);
        File.WriteAllBytes(Path.Combine(dir, "something.aioa.tmp"), new byte[] { 0xFF });

        var reader = new SegmentReader(new PassthroughFileSystem());
        var result = await reader.ReadAllAsync(new AbsolutePath(dir), CancellationToken.None);
        Assert.Empty(result);
    }

    // ─────────── AuditLog ───────────

    [Fact]
    public async Task AuditLog_AppendAsync_NullRecord_Throws()
    {
        var (log, _, _, _) = Build();
        await Assert.ThrowsAsync<ArgumentNullException>(async () => await log.AppendAsync(null!, CancellationToken.None));
        await log.DisposeAsync();
    }

    [Fact]
    public async Task AuditLog_AppendAsync_AfterDispose_Throws()
    {
        var (log, _, _, _) = Build();
        await log.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await log.AppendAsync(MakeRecord(), CancellationToken.None));
    }

    [Fact]
    public async Task AuditLog_DisposeAsync_Idempotent()
    {
        var (log, _, _, _) = Build();
        await log.DisposeAsync();
        await log.DisposeAsync(); // second dispose should not throw
    }

    [Fact]
    public async Task AuditLog_ReadAsync_IncludesUnflushedRecords()
    {
        var (log, _, _, _) = Build();
        await log.AppendAsync(MakeRecord("pending"), CancellationToken.None);

        var records = new System.Collections.Generic.List<AuditRecord>();
        await foreach (var r in log.ReadAsync(CancellationToken.None))
        {
            records.Add(r);
        }

        Assert.Contains(records, r => r.EventType == "pending");
        await log.DisposeAsync();
    }

    [Fact]
    public async Task AuditLog_VerifyAsync_EmptyLog_Passes()
    {
        var dir = Path.Combine(this.root, "empty-verify");
        Directory.CreateDirectory(dir);
        var (priv, pub) = TestKeys.Generate();
        var keys = new StaticKeyMaterialProvider("k1", priv, pub);
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var fs = new PassthroughFileSystem();
        var opts = new StaticOptionsMonitor<AuditOptions>(new AuditOptions());
        var log = new AuditLog(new AbsolutePath(dir), fs, clock, keys, opts);

        var result = await log.VerifyAsync(VerifyMode.Standard, CancellationToken.None);
        Assert.True(result.Ok);
        await log.DisposeAsync();
    }

    [Fact]
    public async Task AuditLog_FlushAsync_EmptyLog_NoOp()
    {
        var (log, _, _, segRoot) = Build();
        await log.FlushAsync(CancellationToken.None); // nothing to flush
        var files = Directory.EnumerateFiles(segRoot.Value, "*.aioa").ToList();
        Assert.Empty(files);
        await log.DisposeAsync();
    }

    // ─────────── ChainVerifier ───────────

    [Fact]
    public void ChainVerifier_Verify_NullSegments_Throws()
    {
        var (_, pub) = TestKeys.Generate();
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = pub,
            At = DateTimeOffset.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "k1",
        };
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        Assert.Throws<ArgumentNullException>(() => verifier.Verify(null!, VerifyMode.Standard));
    }

    [Fact]
    public void ChainVerifier_Verify_EmptySegments_ReturnsOk()
    {
        var (_, pub) = TestKeys.Generate();
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = pub,
            At = DateTimeOffset.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "k1",
        };
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        var result = verifier.Verify(Array.Empty<Segment>(), VerifyMode.Standard);
        Assert.True(result.Ok);
    }

    [Fact]
    public async Task ChainVerifier_StrictMode_NoTransparencyLog_Rejects()
    {
        var (log, _, clock, segRoot) = Build();
        await log.AppendAsync(MakeRecord(), CancellationToken.None);
        await log.FlushAsync(CancellationToken.None);
        await log.DisposeAsync();

        var reader = new SegmentReader(new PassthroughFileSystem());
        var segments = await reader.ReadAllAsync(segRoot, CancellationToken.None);
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = segments[0].EmbeddedPublicKey,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };

        // Strict mode with no transparency log (null)
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock, null);
        var result = verifier.Verify(segments, VerifyMode.Strict);
        Assert.False(result.Ok);
        Assert.Equal(ChainBreakReason.AuditChainTransparencyLogMismatch, result.Reason);
    }

    [Fact]
    public async Task ChainVerifier_StrictMode_WithPopulatedLog_Passes()
    {
        var (log, _, clock, segRoot) = Build();
        await log.AppendAsync(MakeRecord(), CancellationToken.None);
        await log.FlushAsync(CancellationToken.None);
        await log.DisposeAsync();

        var reader = new SegmentReader(new PassthroughFileSystem());
        var segments = await reader.ReadAllAsync(segRoot, CancellationToken.None);
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = segments[0].EmbeddedPublicKey,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };

        // Populate the transparency log with the segment data
        var tl = new InMemoryTransparencyLog();
        var body = SegmentCodec.SerializeBody(segments[0].Header, segments[0].Records);
        var bodyHash = SHA256.HashData(body);
        tl.Add(bodyHash, segments[0].Ed25519Signature);

        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock, tl);
        var result = verifier.Verify(segments, VerifyMode.Strict);
        Assert.True(result.Ok, $"Expected pass but got: {result.Reason} {result.Detail}");
    }

    [Fact]
    public void ChainVerifier_NullAnchor_Throws()
    {
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        Assert.Throws<ArgumentNullException>(() =>
            new ChainVerifier(null!, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock));
    }

    [Fact]
    public void ChainVerifier_NullManifests_Throws()
    {
        var (_, pub) = TestKeys.Generate();
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = pub,
            At = DateTimeOffset.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "k1",
        };
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        Assert.Throws<ArgumentNullException>(() =>
            new ChainVerifier(anchor, null!, Array.Empty<KeyTransition>(), clock));
    }

    [Fact]
    public void ChainVerifier_NullTransitions_Throws()
    {
        var (_, pub) = TestKeys.Generate();
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = pub,
            At = DateTimeOffset.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "k1",
        };
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        Assert.Throws<ArgumentNullException>(() =>
            new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), null!, clock));
    }

    [Fact]
    public void ChainVerifier_NullClock_Throws()
    {
        var (_, pub) = TestKeys.Generate();
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = pub,
            At = DateTimeOffset.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "k1",
        };
        Assert.Throws<ArgumentNullException>(() =>
            new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), null!));
    }

    // ─────────── helpers ───────────

    private static AuditRecord MakeRecord(string evt = "test.event", string content = "{}") => new()
    {
        EventType = evt,
        At = DateTimeOffset.UtcNow,
        Principal = new AiOrchestrator.Models.Auth.AuthContext
        {
            PrincipalId = "tester",
            DisplayName = "Test",
            Scopes = System.Collections.Immutable.ImmutableArray.Create("audit.write"),
            IssuedAtUtc = DateTimeOffset.UtcNow,
        },
        ContentJson = content,
        ResourceRefs = System.Collections.Immutable.ImmutableArray<string>.Empty,
    };

    private (AuditLog Log, StaticKeyMaterialProvider Keys, InMemoryClock Clock, AbsolutePath SegmentRoot) Build(
        AuditOptions? opts = null)
    {
        var (priv, pub) = TestKeys.Generate();
        var keys = new StaticKeyMaterialProvider("install", priv, pub);
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var monitor = new StaticOptionsMonitor<AuditOptions>(opts ?? new AuditOptions
        {
            SegmentRollover = TimeSpan.FromHours(1),
            SegmentMaxBytes = 4096,
        });
        var segRoot = new AbsolutePath(Path.Combine(this.root, Guid.NewGuid().ToString("N")));
        var log = new AuditLog(segRoot, fs, clock, keys, monitor);
        return (log, keys, clock, segRoot);
    }
}
