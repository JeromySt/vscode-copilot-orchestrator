// <copyright file="SkewManifestCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.SkewManifest.Verification;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.SkewManifest.Tests;

/// <summary>Additional tests to raise coverage across lifecycle, verifier and transparency paths.</summary>
public sealed class SkewManifestCoverageTests
{
    private static SkewManifestObserver BuildObserver(
        SkewManifestOptions opts,
        InMemoryClock clock,
        HttpMessageHandler handler,
        RecordingAuditLog? audit = null,
        RecordingEventBus? bus = null)
    {
        var monitor = new FakeOptionsMonitor<SkewManifestOptions>(opts);
        var factory = new StubHttpClientFactory(handler);
        return new SkewManifestObserver(
            factory,
            new StubFileSystem(),
            clock,
            audit ?? new RecordingAuditLog(),
            bus ?? new RecordingEventBus(),
            monitor,
            NullLogger<SkewManifestObserver>.Instance);
    }

    private static HttpResponseMessage Json(string content) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(content, System.Text.Encoding.UTF8, "application/json"),
    };

    [Fact]
    public async Task StartAsync_StopAsync_DrivesFetchLoop_Once()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            PollInterval = TimeSpan.FromMinutes(60),
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(manifest.SignedAt.AddSeconds(1));
        var audit = new RecordingAuditLog();
        var observer = BuildObserver(opts, clock, new StubHandler(_ => Json(ManifestFactory.Serialize(manifest))), audit);

        await observer.StartAsync(CancellationToken.None);

        // Wait for at least one fetch to land.
        for (var i = 0; i < 50 && audit.Records.Count == 0; i++)
        {
            await Task.Delay(20);
        }

        await observer.StopAsync(CancellationToken.None);

Assert.NotEmpty(audit.Records);
        var current = await observer.CurrentAsync(CancellationToken.None);
Assert.NotNull(current);
    }

    [Fact]
    public async Task DisposeAsync_IsIdempotent_AndStopsLoop()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            PollInterval = TimeSpan.FromMinutes(60),
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(manifest.SignedAt.AddSeconds(1));
        var observer = BuildObserver(opts, clock, new StubHandler(_ => Json(ManifestFactory.Serialize(manifest))));

        await observer.StartAsync(CancellationToken.None);
        await Task.Delay(50);
        await observer.DisposeAsync();

        // Second dispose is a no-op.
        await observer.DisposeAsync();
    }

    [Fact]
    public async Task FetchOnceAsync_RejectsWhenHttpRequestFails()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(manifest.SignedAt.AddSeconds(1));
        var handler = new StubHandler(_ => throw new HttpRequestException("network boom"));
        var observer = BuildObserver(opts, clock, handler);

        var result = await observer.FetchOnceAsync(CancellationToken.None);

Assert.False(result.Ok);
Assert.Equal(SkewManifestRejectionReason.InvalidSignature, result.Reason);
Assert.Contains("network boom", result.Detail);
    }

    [Fact]
    public async Task FetchOnceAsync_RejectsMalformedJson()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        _ = manifest;
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var handler = new StubHandler(_ => Json("not json"));
        var observer = BuildObserver(opts, clock, handler);

        var result = await observer.FetchOnceAsync(CancellationToken.None);
Assert.False(result.Ok);
    }

    [Fact]
    public async Task VerifyAsync_Throws_OnNullManifest()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = ImmutableArray<byte[]>.Empty,
            EmergencyRevocationPublicKeys = ImmutableArray<byte[]>.Empty,
        };
        var observer = BuildObserver(opts, new InMemoryClock(DateTimeOffset.UtcNow), new StubHandler(_ => Json("{}")));

        Func<Task> act = async () => await observer.VerifyAsync(null!, CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    [Fact]
    public async Task VerifyAsync_RejectsUnsupportedAlgorithm()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var tampered = manifest with
        {
            HsmSignatures = manifest.HsmSignatures
                .Select(s => new HsmSignature { HsmId = s.HsmId, Algorithm = "RSA", Signature = s.Signature })
                .ToImmutableArray(),
        };
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        var observer = BuildObserver(opts, new InMemoryClock(manifest.SignedAt.AddSeconds(1)), new StubHandler(_ => Json("{}")));

        var v = await observer.VerifyAsync(tampered, CancellationToken.None);
Assert.False(v.Ok);
Assert.Equal(SkewManifestRejectionReason.InvalidSignature, v.Reason);
    }

    [Fact]
    public async Task TransparencyLog_HttpFailure_PropagatesAsMismatch()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
            TransparencyLogUrl = "https://tlog.example.test/check",
        };

        var handler = new StubHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.StartsWith("https://tlog.", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.InternalServerError)
                {
                    Content = new StringContent("fail"),
                };
            }

            return Json(ManifestFactory.Serialize(manifest));
        });
        var observer = BuildObserver(opts, new InMemoryClock(manifest.SignedAt.AddSeconds(1)), handler);

        var v = await observer.VerifyAsync(manifest, CancellationToken.None);
Assert.False(v.Ok);
Assert.Equal(SkewManifestRejectionReason.TransparencyLogMismatch, v.Reason);
    }

    [Fact]
    public async Task TransparencyLog_NotIncludedResponse_Rejected()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
            TransparencyLogUrl = "https://tlog.example.test/check",
        };

        var handler = new StubHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.StartsWith("https://tlog.", StringComparison.Ordinal))
            {
                return Json("{\"included\":false,\"reason\":\"unknown manifest\"}");
            }

            return Json(ManifestFactory.Serialize(manifest));
        });
        var observer = BuildObserver(opts, new InMemoryClock(manifest.SignedAt.AddSeconds(1)), handler);

        var v = await observer.VerifyAsync(manifest, CancellationToken.None);
Assert.False(v.Ok);
Assert.Equal(SkewManifestRejectionReason.TransparencyLogMismatch, v.Reason);
Assert.Contains("unknown manifest", v.Detail);
    }

    [Fact]
    public async Task TransparencyLog_HttpRequestException_ReportsMismatch()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
            TransparencyLogUrl = "https://tlog.example.test/check",
        };

        var handler = new StubHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.StartsWith("https://tlog.", StringComparison.Ordinal))
            {
                throw new HttpRequestException("dns fail");
            }

            return Json(ManifestFactory.Serialize(manifest));
        });
        var observer = BuildObserver(opts, new InMemoryClock(manifest.SignedAt.AddSeconds(1)), handler);

        var v = await observer.VerifyAsync(manifest, CancellationToken.None);
Assert.False(v.Ok);
Assert.Equal(SkewManifestRejectionReason.TransparencyLogMismatch, v.Reason);
Assert.Contains("dns fail", v.Detail);
    }

    [Fact]
    public void HsmSignatureVerifier_InvalidAlgorithm_SetsFailureDetail()
    {
        var (manifest, hsmKeys, _) = ManifestFactory.BuildSigned();
        var tampered = manifest with
        {
            HsmSignatures = manifest.HsmSignatures
                .Select(s => new HsmSignature { HsmId = s.HsmId, Algorithm = "RSA", Signature = s.Signature })
                .ToImmutableArray(),
        };
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = ImmutableArray<byte[]>.Empty,
            RequiredHsmSignatures = 3,
        };
        var verifier = new HsmSignatureVerifier(new FakeOptionsMonitor<SkewManifestOptions>(opts));

        var ok = verifier.TryVerify(tampered, out var validCount, out var detail);

Assert.False(ok);
Assert.Equal(0, validCount);
Assert.NotNull(detail);
    }

    [Fact]
    public void HsmSignatureVerifier_SignatureLengthMismatch_ReturnsNoMatch()
    {
        var (manifest, hsmKeys, _) = ManifestFactory.BuildSigned(hsmKeyCount: 5, hsmSignatureCount: 3);
        var tampered = manifest with
        {
            HsmSignatures = manifest.HsmSignatures
                .Select(s => new HsmSignature { HsmId = s.HsmId, Algorithm = "ECDSA-P256", Signature = new byte[8] })
                .ToImmutableArray(),
        };
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = ImmutableArray<byte[]>.Empty,
            RequiredHsmSignatures = 3,
        };
        var verifier = new HsmSignatureVerifier(new FakeOptionsMonitor<SkewManifestOptions>(opts));

        var ok = verifier.TryVerify(tampered, out var validCount, out var detail);

Assert.False(ok);
Assert.Equal(0, validCount);
Assert.NotNull(detail);
    }

    [Fact]
    public void HsmSignatureVerifier_MalformedPubKeyLength_Ignored()
    {
        var (manifest, hsmKeys, _) = ManifestFactory.BuildSigned(hsmKeyCount: 5, hsmSignatureCount: 3);
        var badKeys = hsmKeys.Insert(0, new byte[1]);
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = badKeys,
            EmergencyRevocationPublicKeys = ImmutableArray<byte[]>.Empty,
            RequiredHsmSignatures = 3,
        };
        var verifier = new HsmSignatureVerifier(new FakeOptionsMonitor<SkewManifestOptions>(opts));

        // Still succeeds because real keys sit after the malformed one.
        var ok = verifier.TryVerify(manifest, out var validCount, out _);

Assert.True(ok);
Assert.True(validCount >= 3);
    }

    [Fact]
    public async Task CurrentAsync_InitiallyNull()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = ImmutableArray<byte[]>.Empty,
            EmergencyRevocationPublicKeys = ImmutableArray<byte[]>.Empty,
        };
        var observer = BuildObserver(opts, new InMemoryClock(DateTimeOffset.UtcNow), new StubHandler(_ => Json("{}")));

        var current = await observer.CurrentAsync(CancellationToken.None);
Assert.Null(current);
    }
}
