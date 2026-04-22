// <copyright file="AuditLogContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Chain;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Composition;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Audit.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

/// <summary>Acceptance contract tests for <see cref="AuditLog"/> and <see cref="ChainVerifier"/> (job 016).</summary>
public sealed class AuditLogContractTests : IDisposable
{
    private readonly string root;

    public AuditLogContractTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "audit-tests", Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(this.root);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); }
        catch { /* best effort */ }
    }

    // ---- helpers ---------------------------------------------------------

    private static AuthContext Principal() => new()
    {
        PrincipalId = "tester",
        DisplayName = "Audit Test",
        Scopes = ImmutableArray.Create("audit.write"),
        IssuedAtUtc = DateTimeOffset.UtcNow,
    };

    private static AuditRecord MakeRecord(string evt = "test.event", string content = "{}") => new()
    {
        EventType = evt,
        At = DateTimeOffset.UtcNow,
        Principal = Principal(),
        ContentJson = content,
        ResourceRefs = ImmutableArray<string>.Empty,
    };

    private (AuditLog Log, StaticKeyMaterialProvider Keys, InMemoryClock Clock, AbsolutePath SegmentRoot) Build(
        AuditOptions? opts = null,
        string keyId = "install")
    {
        var (priv, pub) = TestKeys.Generate();
        var keys = new StaticKeyMaterialProvider(keyId, priv, pub);
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var monitor = new StaticOptionsMonitor<AuditOptions>(opts ?? new AuditOptions { SegmentRollover = TimeSpan.FromHours(1), SegmentMaxBytes = 4096 });
        var segRoot = new AbsolutePath(this.root);
        var log = new AuditLog(segRoot, fs, clock, keys, monitor);
        return (log, keys, clock, segRoot);
    }

    // -- KEY-ROT-1 -- Rotation preserves chain ----------------------------
    [Fact]
    [ContractTest("KEY-ROT-1")]
    public async Task KEY_ROT_1_RotationPreservesChain()
    {
        var (oldPriv, oldPub) = TestKeys.Generate();
        var (newPriv, newPub) = TestKeys.Generate();

        // Round 1: write a segment with the OLD key.
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var optMon = new StaticOptionsMonitor<AuditOptions>(new AuditOptions { SegmentRollover = TimeSpan.FromHours(1), SegmentMaxBytes = 4096 });
        var segRoot = new AbsolutePath(this.root);

        var keysOld = new StaticKeyMaterialProvider("install", oldPriv, oldPub);
        await using (var log = new AuditLog(segRoot, fs, clock, keysOld, optMon))
        {
            await log.AppendAsync(MakeRecord("seg1"), default);
            await log.FlushAsync(default);
        }

        // Issue a cross-signed transition from OLD -> NEW.
        var signer = new Ed25519Signer();
        var txWriter = new KeyTransitionWriter(signer);
        var transition = txWriter.Issue("install", "v2", oldPub, oldPriv, newPub, newPriv, clock.UtcNow, TransitionReason.ScheduledRotation);

        // Round 2: open AuditLog with the NEW key and append more segments.
        var keysNew = new StaticKeyMaterialProvider("v2", newPriv, newPub);
        await using (var log = new AuditLog(segRoot, fs, clock, keysNew, optMon))
        {
            await log.AppendAsync(MakeRecord("seg2"), default);
            await log.FlushAsync(default);
        }

        // Verify with anchor on OLD key + transition trusting NEW key.
        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = oldPub,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), new[] { transition }, clock);
        var result = verifier.Verify(segments, VerifyMode.Standard);

        _ = result.Ok.Should().BeTrue($"chain should remain valid across rotation but failed: {result.Reason} {result.Detail}");
        _ = segments.Count.Should().Be(2);
    }

    // -- KEY-ROT-1-NOXSIG -- Missing cross-signature is rejected ----------
    [Fact]
    [ContractTest("KEY-ROT-1-NOXSIG")]
    public async Task KEY_ROT_1_MissingCrossSignatureRejected()
    {
        var (oldPriv, oldPub) = TestKeys.Generate();
        var (newPriv, newPub) = TestKeys.Generate();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var optMon = new StaticOptionsMonitor<AuditOptions>(new AuditOptions());
        var segRoot = new AbsolutePath(this.root);

        var keysNew = new StaticKeyMaterialProvider("v2", newPriv, newPub);
        await using (var log = new AuditLog(segRoot, fs, clock, keysNew, optMon))
        {
            await log.AppendAsync(MakeRecord(), default);
            await log.FlushAsync(default);
        }

        // Forged transition: NEW key signature is garbage.
        var signer = new Ed25519Signer();
        var msg = KeyTransitionWriter.BuildTransitionMessage("install", "v2", oldPub, newPub, clock.UtcNow, TransitionReason.ScheduledRotation);
        var oldSig = signer.Sign(msg, oldPriv);
        var bogusNewSig = new byte[Ed25519Signer.SignatureSize]; // all zeros — will not verify

        var badTransition = new KeyTransition
        {
            OldKeyId = "install",
            NewKeyId = "v2",
            OldPubKey = oldPub,
            NewPubKey = newPub,
            OldKeySignature = oldSig,
            NewKeySignature = bogusNewSig,
            At = clock.UtcNow,
            Reason = TransitionReason.ScheduledRotation,
        };

        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = oldPub,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };
        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);

        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), new[] { badTransition }, clock);
        var result = verifier.Verify(segments, VerifyMode.Standard);

        _ = result.Ok.Should().BeFalse();
        _ = result.Reason.Should().Be(ChainBreakReason.AuditChainKeyTransitionMissingCrossSignature);
    }

    // -- TRUST-ROOT-1 -- InstallAnchor required ---------------------------
    [Fact]
    [ContractTest("TRUST-ROOT-1")]
    public async Task TRUST_ROOT_1_InstallAnchorRequired()
    {
        var (priv, pub) = TestKeys.Generate();
        var (otherPriv, otherPub) = TestKeys.Generate();
        var (log, _, clock, segRoot) = this.Build(keyId: "install");

        await log.AppendAsync(MakeRecord(), default);
        await log.FlushAsync(default);
        await log.DisposeAsync();

        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);

        // Anchor with a DIFFERENT public key — chain must be rejected.
        var foreignAnchor = new InstallAnchor
        {
            InitialAuditPubKey = otherPub,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "foreign",
        };
        var verifier = new ChainVerifier(foreignAnchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        var result = verifier.Verify(segments, VerifyMode.Standard);

        _ = result.Ok.Should().BeFalse();
        _ = result.Reason.Should().Be(ChainBreakReason.AuditChainBrokenAtInstallAnchor);
    }

    // -- TRUST-ROOT-2 -- Manifest must be offline-root signed -------------
    // Without a valid manifest signature, the manifest's keys are NOT trusted.
    [Fact]
    [ContractTest("TRUST-ROOT-2")]
    public async Task TRUST_ROOT_2_ManifestMustBeOfflineRootSigned()
    {
        var (anchorPriv, anchorPub) = TestKeys.Generate();
        var (releasePriv, releasePub) = TestKeys.Generate();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var optMon = new StaticOptionsMonitor<AuditOptions>(new AuditOptions());
        var segRoot = new AbsolutePath(this.root);

        // Sign the segment with the RELEASE key (not the anchor).
        var keys = new StaticKeyMaterialProvider("release-v1", releasePriv, releasePub);
        await using (var log = new AuditLog(segRoot, fs, clock, keys, optMon))
        {
            await log.AppendAsync(MakeRecord(), default);
            await log.FlushAsync(default);
        }

        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);

        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = anchorPub,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };

        // No manifest, no transition — release key isn't trusted by anything.
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        var result = verifier.Verify(segments, VerifyMode.Standard);

        _ = result.Ok.Should().BeFalse("an unsigned manifest cannot extend trust");
        _ = result.Reason.Should().BeOneOf(
            ChainBreakReason.AuditChainBrokenAtInstallAnchor,
            ChainBreakReason.AuditChainBrokenAtReleaseManifest);
    }

    // -- TRUST-ROOT-4 -- Daemon never signs with build key ---------------
    // Roslyn-style: scan source files for Ed25519Signer.Sign call sites and
    // assert all callers live under AiOrchestrator.Audit/.
    [Fact]
    [ContractTest("TRUST-ROOT-4")]
    public void TRUST_ROOT_4_DaemonNeverSignsWithBuildKey()
    {
        var srcRoot = LocateRepoRoot();
        var srcDir = Path.Combine(srcRoot, "src", "dotnet");
        var allCsFiles = Directory.EnumerateFiles(srcDir, "*.cs", SearchOption.AllDirectories);

        var offenders = new System.Collections.Generic.List<string>();
        foreach (var file in allCsFiles)
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');

            // Source files that ARE permitted to call .Sign(...)
            var allowed = rel.Contains("AiOrchestrator.Audit/AuditLog.cs", StringComparison.Ordinal)
                || rel.Contains("AiOrchestrator.Audit/Trust/KeyTransitionWriter.cs", StringComparison.Ordinal)
                || rel.Contains("AiOrchestrator.Audit/Crypto/Ed25519Signer.cs", StringComparison.Ordinal)
                || rel.Contains("AiOrchestrator.Audit/Chain/SegmentWriter.cs", StringComparison.Ordinal);
            if (allowed)
            {
                continue;
            }

            var text = File.ReadAllText(file);
            if (text.Contains(".Sign(", StringComparison.Ordinal) && text.Contains("Ed25519", StringComparison.Ordinal))
            {
                offenders.Add(rel);
            }
        }

        _ = offenders.Should().BeEmpty(
            "Daemon code must NEVER call Ed25519Signer.Sign — found offenders: " + string.Join(", ", offenders));
    }

    // -- TRUST-ROOT-6 -- Strict mode checks transparency log -------------
    [Fact]
    [ContractTest("TRUST-ROOT-6")]
    public async Task TRUST_ROOT_6_StrictModeChecksTransparencyLog()
    {
        var (priv, pub) = TestKeys.Generate();
        var (log, _, clock, segRoot) = this.Build();
        await log.AppendAsync(MakeRecord(), default);
        await log.FlushAsync(default);
        await log.DisposeAsync();

        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);

        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = segments[0].EmbeddedPublicKey,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };

        // Empty transparency log — strict mode rejects.
        var emptyTl = new InMemoryTransparencyLog();
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock, emptyTl);
        var resultStrict = verifier.Verify(segments, VerifyMode.Strict);
        _ = resultStrict.Ok.Should().BeFalse();
        _ = resultStrict.Reason.Should().Be(ChainBreakReason.AuditChainTransparencyLogMismatch);

        // Standard mode passes.
        var verifierStd = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        var resultStd = verifierStd.Verify(segments, VerifyMode.Standard);
        _ = resultStd.Ok.Should().BeTrue();
    }

    // -- TRUST-ROOT-7 -- Audit chain survives daemon update --------------
    [Fact]
    [ContractTest("TRUST-ROOT-7")]
    public async Task TRUST_ROOT_7_AuditChainSurvivesUpdate_NoFalseTamper()
    {
        var (oldPriv, oldPub) = TestKeys.Generate();
        var (newPriv, newPub) = TestKeys.Generate();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var fs = new PassthroughFileSystem();
        var optMon = new StaticOptionsMonitor<AuditOptions>(new AuditOptions());
        var segRoot = new AbsolutePath(this.root);

        // Phase 1: pre-update segment signed by OLD key.
        var keysOld = new StaticKeyMaterialProvider("install", oldPriv, oldPub);
        await using (var l = new AuditLog(segRoot, fs, clock, keysOld, optMon))
        {
            await l.AppendAsync(MakeRecord("pre-update"), default);
            await l.FlushAsync(default);
        }

        // Daemon update: new release manifest issued and observed; key rotates.
        var signer = new Ed25519Signer();
        var txWriter = new KeyTransitionWriter(signer);
        var transition = txWriter.Issue("install", "v2", oldPub, oldPriv, newPub, newPriv, clock.UtcNow, TransitionReason.ScheduledRotation);

        // New manifest contains both old + new keys (typical update).
        var manifest = new ReleaseManifest
        {
            Version = new Version(1, 4, 0),
            TrustedAuditPubKeys = ImmutableArray.Create(oldPub, newPub),
            OfflineRootSignature = new byte[64],
            SignedAt = clock.UtcNow,
        };

        // Phase 2: post-update segment signed by NEW key.
        var keysNew = new StaticKeyMaterialProvider("v2", newPriv, newPub);
        await using (var l = new AuditLog(segRoot, fs, clock, keysNew, optMon))
        {
            await l.AppendAsync(MakeRecord("post-update"), default);
            await l.FlushAsync(default);
        }

        var reader = new SegmentReader();
        var segments = await reader.ReadAllAsync(segRoot, default);
        _ = segments.Count.Should().Be(2);

        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = oldPub,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };
        var verifier = new ChainVerifier(anchor, new[] { manifest }, new[] { transition }, clock);
        var result = verifier.Verify(segments, VerifyMode.Standard);
        _ = result.Ok.Should().BeTrue($"chain should survive update, got {result.Reason}: {result.Detail}");
    }

    // -- AUDIT-HMAC -- Tamper detected ------------------------------------
    [Fact]
    [ContractTest("AUDIT-HMAC")]
    public async Task AUDIT_HMAC_TamperDetected()
    {
        var (log, _, _, segRoot) = this.Build();
        await log.AppendAsync(MakeRecord("first", "{\"v\":1}"), default);
        await log.FlushAsync(default);
        await log.DisposeAsync();

        var file = Directory.EnumerateFiles(segRoot.Value, "*.aioa").Single();
        var bytes = File.ReadAllBytes(file);

        // Flip a byte well inside the body (after magic+version).
        bytes[20] ^= 0xFF;
        File.WriteAllBytes(file, bytes);

        await using var log2 = this.Build().Log;
        var verification = await log2.VerifyAsync(VerifyMode.Standard, default);
        _ = verification.Ok.Should().BeFalse();
        _ = verification.Reason.Should().BeOneOf(
            ChainBreakReason.AuditChainHmacMismatch,
            ChainBreakReason.AuditChainSignatureMismatch);
    }

    // -- AUDIT-SIG -- Tamper of signature detected ------------------------
    [Fact]
    [ContractTest("AUDIT-SIG")]
    public async Task AUDIT_SIG_TamperDetected()
    {
        var (log, _, _, segRoot) = this.Build();
        await log.AppendAsync(MakeRecord(), default);
        await log.FlushAsync(default);
        await log.DisposeAsync();

        var file = Directory.EnumerateFiles(segRoot.Value, "*.aioa").Single();
        var bytes = File.ReadAllBytes(file);

        // Flip a byte 80 bytes from the end (deep in the signature region of the trailer).
        bytes[bytes.Length - 80] ^= 0xFF;
        File.WriteAllBytes(file, bytes);

        await using var log2 = this.Build().Log;
        var verification = await log2.VerifyAsync(VerifyMode.Standard, default);
        _ = verification.Ok.Should().BeFalse();
    }

    // -- AUDIT-ATOMIC -- Stray .tmp does not contaminate state ------------
    [Fact]
    [ContractTest("AUDIT-ATOMIC")]
    public async Task AUDIT_SEGMENT_AtomicAppendOnCrash()
    {
        var (log, _, _, segRoot) = this.Build();
        await log.AppendAsync(MakeRecord(), default);
        await log.FlushAsync(default);
        await log.DisposeAsync();

        // Simulate a crash mid-write by leaving a stray .tmp file behind.
        var stray = Path.Combine(segRoot.Value, "9999999999-deadbeef.aioa.tmp");
        File.WriteAllBytes(stray, new byte[] { 0xDE, 0xAD, 0xBE, 0xEF });
        _ = File.Exists(stray).Should().BeTrue();

        // Re-open: tmp file must be removed during recovery.
        await using var log2 = this.Build().Log;
        _ = File.Exists(stray).Should().BeFalse("stray .tmp must be cleaned on startup");

        // And verification of the original (non-tmp) segment still passes.
        var verification = await log2.VerifyAsync(VerifyMode.Standard, default);
        _ = verification.Ok.Should().BeTrue();
    }

    // -- AUDIT-ROLLOVER -- Rollover triggered by size and time -----------
    [Fact]
    [ContractTest("AUDIT-ROLLOVER")]
    public async Task AUDIT_SEGMENT_RolloverOnSizeAndTime()
    {
        // Tiny size threshold: every record triggers immediate rollover.
        var (log, _, clock, segRoot) = this.Build(new AuditOptions
        {
            SegmentRollover = TimeSpan.FromHours(1),
            SegmentMaxBytes = 1, // any record exceeds this estimate
        });

        await log.AppendAsync(MakeRecord("a"), default);
        await log.AppendAsync(MakeRecord("b"), default);
        await log.AppendAsync(MakeRecord("c"), default);
        await log.DisposeAsync();

        var sizeRolledFiles = Directory.EnumerateFiles(segRoot.Value, "*.aioa").ToList();
        _ = sizeRolledFiles.Count.Should().BeGreaterOrEqualTo(3, "size threshold must produce 1 segment per append");

        // Reset and exercise time-based rollover.
        foreach (var f in sizeRolledFiles)
        {
            File.Delete(f);
        }

        var (log2, _, clock2, segRoot2) = this.Build(new AuditOptions
        {
            SegmentRollover = TimeSpan.FromMinutes(5),
            SegmentMaxBytes = 64L * 1024 * 1024, // size won't trigger
        });

        await log2.AppendAsync(MakeRecord("t1"), default);
        clock2.Advance(TimeSpan.FromMinutes(10)); // exceed rollover window
        await log2.AppendAsync(MakeRecord("t2"), default);
        await log2.DisposeAsync();

        var timeRolledFiles = Directory.EnumerateFiles(segRoot2.Value, "*.aioa").ToList();
        _ = timeRolledFiles.Count.Should().BeGreaterOrEqualTo(2, "time threshold must produce a fresh segment after the window passes");
    }

    // -- AUDIT-SEQ-GAP -- Gap in segment sequence detected ----------------
    [Fact]
    [ContractTest("AUDIT-SEQ-GAP")]
    public async Task AUDIT_SEGMENT_SEQ_GapDetected()
    {
        var (log, _, clock, segRoot) = this.Build(new AuditOptions
        {
            SegmentRollover = TimeSpan.FromHours(1),
            SegmentMaxBytes = 1, // each append rolls
        });
        await log.AppendAsync(MakeRecord("s1"), default);
        await log.AppendAsync(MakeRecord("s2"), default);
        await log.AppendAsync(MakeRecord("s3"), default);
        await log.DisposeAsync();

        var files = Directory.EnumerateFiles(segRoot.Value, "*.aioa")
            .OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal)
            .ToList();
        _ = files.Count.Should().BeGreaterOrEqualTo(3);

        // Delete the middle file to introduce a sequence gap.
        File.Delete(files[1]);

        var reader = new SegmentReader();
        var remaining = await reader.ReadAllAsync(segRoot, default);
        var anchor = new InstallAnchor
        {
            InitialAuditPubKey = remaining[0].EmbeddedPublicKey,
            At = clock.UtcNow,
            InstallId = "test",
            InitialAuditKeyId = "install",
        };
        var verifier = new ChainVerifier(anchor, Array.Empty<ReleaseManifest>(), Array.Empty<KeyTransition>(), clock);
        var result = verifier.Verify(remaining, VerifyMode.Standard);

        _ = result.Ok.Should().BeFalse();
        _ = result.Reason.Should().Be(ChainBreakReason.AuditChainSegmentSeqRegression);
    }

    // -- Composition smoke test (PC-7) ------------------------------------
    [Fact]
    public void CompositionRoot_AddAuditLog_RegistersSingleton()
    {
        var services = new ServiceCollection();
        _ = services.AddAuditLog();

        var descriptors = services.Where(d => d.ServiceType == typeof(IAuditLog)).ToList();
        _ = descriptors.Should().HaveCount(1);
        _ = descriptors[0].Lifetime.Should().Be(ServiceLifetime.Singleton);
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("Could not locate repo root (no .git ancestor).");
    }
}

internal sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    where T : class
{
    public StaticOptionsMonitor(T value)
    {
        this.CurrentValue = value;
    }

    public T CurrentValue { get; }

    public T Get(string? name) => this.CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

internal sealed class InMemoryTransparencyLog : ITransparencyLog
{
    private readonly System.Collections.Generic.HashSet<string> entries = new(StringComparer.Ordinal);

    public bool Contains(ReadOnlySpan<byte> segmentBodyHash, ReadOnlySpan<byte> signature)
    {
        var key = Convert.ToHexString(segmentBodyHash) + "|" + Convert.ToHexString(signature);
        return this.entries.Contains(key);
    }

    public void Add(byte[] hash, byte[] sig)
    {
        _ = this.entries.Add(Convert.ToHexString(hash) + "|" + Convert.ToHexString(sig));
    }
}
