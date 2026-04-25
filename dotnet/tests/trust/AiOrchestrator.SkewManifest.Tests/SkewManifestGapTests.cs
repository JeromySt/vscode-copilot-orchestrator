// <copyright file="SkewManifestGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.SkewManifest.Tools;
using AiOrchestrator.SkewManifest.Verification;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.SkewManifest.Tests;

/// <summary>Gap-filling tests for SkewManifestObserver, KeyCeremonyToolingStub, and TransparencyLogChecker.</summary>
public sealed class SkewManifestGapTests
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

    // ---- KeyCeremonyToolingStub ----

    [Fact]
    public void KeyCeremonyToolingStub_IsSealed()
    {
        Assert.True(typeof(KeyCeremonyToolingStub).IsSealed);
    }

    [Fact]
    public void KeyCeremonyToolingStub_HasNoPublicConstructor()
    {
        var ctors = typeof(KeyCeremonyToolingStub).GetConstructors(
            System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
        Assert.Empty(ctors);
    }

    // ---- SkewManifestObserver.VerifyAsync — clock skew (SignedAt in future) ----

    [Fact]
    public async Task VerifyAsync_FutureSignedAt_RejectsExpiredManifest()
    {
        var signedAt = DateTimeOffset.UtcNow.AddMinutes(10); // 10 minutes in the future
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned(
            signedAt: signedAt,
            notValidAfter: signedAt.AddDays(365));
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var observer = BuildObserver(opts, clock,
            new StubHandler(_ => Json(ManifestFactory.Serialize(manifest))));

        var result = await observer.VerifyAsync(manifest, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal(SkewManifestRejectionReason.ExpiredManifest, result.Reason);
    }

    // ---- SkewManifestObserver.VerifyAsync — unsupported algorithm ----

    [Fact]
    public async Task VerifyAsync_UnsupportedAlgorithm_RejectsInvalidSignature()
    {
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned();
        // Replace algorithm with something unsupported.
        var badSigs = manifest.HsmSignatures
            .Select(s => s with { Algorithm = "RSA-4096" })
            .ToImmutableArray();
        var badManifest = manifest with { HsmSignatures = badSigs };

        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(manifest.SignedAt.AddSeconds(1));
        var observer = BuildObserver(opts, clock,
            new StubHandler(_ => Json(ManifestFactory.Serialize(manifest))));

        var result = await observer.VerifyAsync(badManifest, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal(SkewManifestRejectionReason.InvalidSignature, result.Reason);
    }

    // ---- TransparencyLogChecker — no URL configured ----

    [Fact]
    public async Task TransparencyLogChecker_NoUrl_ReturnsIncluded()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            TransparencyLogUrl = null,
        };
        var monitor = new FakeOptionsMonitor<SkewManifestOptions>(opts);
        var http = new StubHttpClientFactory(new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)));
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);

        var checker = new TransparencyLogChecker(http, clock, monitor);
        var (manifest, _, _) = ManifestFactory.BuildSigned();

        var result = await checker.CheckAsync(manifest, CancellationToken.None);

        Assert.True(result.Included);
        Assert.Null(result.FailureReason);
    }

    // ---- TransparencyLogChecker — HTTP error ----

    [Fact]
    public async Task TransparencyLogChecker_HttpError_ReturnsNotIncluded()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            TransparencyLogUrl = "https://tlog.example.test/check",
        };
        var monitor = new FakeOptionsMonitor<SkewManifestOptions>(opts);
        var http = new StubHttpClientFactory(new StubHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.InternalServerError)));
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);

        var checker = new TransparencyLogChecker(http, clock, monitor);
        var (manifest, _, _) = ManifestFactory.BuildSigned();

        var result = await checker.CheckAsync(manifest, CancellationToken.None);

        Assert.False(result.Included);
        Assert.Contains("500", result.FailureReason);
    }

    // ---- TransparencyLogChecker — network failure ----

    [Fact]
    public async Task TransparencyLogChecker_NetworkFailure_ReturnsNotIncluded()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            TransparencyLogUrl = "https://tlog.example.test/check",
        };
        var monitor = new FakeOptionsMonitor<SkewManifestOptions>(opts);
        var http = new StubHttpClientFactory(new StubHandler(_ =>
            throw new HttpRequestException("DNS resolution failed")));
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);

        var checker = new TransparencyLogChecker(http, clock, monitor);
        var (manifest, _, _) = ManifestFactory.BuildSigned();

        var result = await checker.CheckAsync(manifest, CancellationToken.None);

        Assert.False(result.Included);
        Assert.Contains("DNS", result.FailureReason);
    }

    // ---- SkewManifestObserver.CurrentAsync returns null when not started ----

    [Fact]
    public async Task CurrentAsync_BeforeStart_ReturnsNull()
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
        var observer = BuildObserver(opts, clock,
            new StubHandler(_ => Json(ManifestFactory.Serialize(manifest))));

        var current = await observer.CurrentAsync(CancellationToken.None);

        Assert.Null(current);
    }
}
