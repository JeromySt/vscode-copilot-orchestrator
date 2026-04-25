// <copyright file="SkewManifestGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.SkewManifest.Verification;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.SkewManifest.Tests;

/// <summary>Targeted coverage-gap tests for SkewManifest assembly (~7 lines).</summary>
public sealed class SkewManifestGap2Tests
{
    // ================================================================
    // SkewManifestObserver.VerifyAsync — version regression
    // ================================================================

    [Fact]
    public async Task VerifyAsync_VersionRegression_RejectsVersionRegression()
    {
        var v1 = new Version(2, 0);
        var v2 = new Version(1, 0); // lower version

        // Build first manifest at v2.0 and verify it (establishes lastManifestVersion)
        var (manifest1, hsmKeys, emKeys) = ManifestFactory.BuildSigned(manifestVersion: v1);
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            TransparencyLogUrl = null,
            KnownHsmPublicKeys = hsmKeys,
            EmergencyRevocationPublicKeys = emKeys,
            RequiredHsmSignatures = 3,
        };
        var clock = new InMemoryClock(manifest1.SignedAt.AddSeconds(1));
        var handler = new StubHandler(_ => Json(ManifestFactory.Serialize(manifest1)));
        var observer = BuildObserver(opts, clock, handler);

        // Fetch once to establish the version
        await observer.FetchOnceAsync(CancellationToken.None);

        // Now try to verify a manifest with lower version
        var (manifest2, _, _) = ManifestFactory.BuildSigned(
            manifestVersion: v2,
            signedAt: manifest1.SignedAt.AddSeconds(2),
            notValidAfter: manifest1.SignedAt.AddDays(365));

        var result = await observer.VerifyAsync(manifest2, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Equal(SkewManifestRejectionReason.VersionRegression, result.Reason);
    }

    // ================================================================
    // SkewManifestObserver — NotValidAfter expired
    // ================================================================

    [Fact]
    public async Task VerifyAsync_ExpiredNotValidAfter_RejectsExpiredManifest()
    {
        var pastDate = DateTimeOffset.UtcNow.AddDays(-10);
        var (manifest, hsmKeys, emKeys) = ManifestFactory.BuildSigned(
            signedAt: pastDate.AddDays(-5),
            notValidAfter: pastDate); // expired 10 days ago

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

    // ================================================================
    // SkewManifestObserver.DisposeAsync — idempotent
    // ================================================================

    [Fact]
    public async Task DisposeAsync_IsIdempotent()
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

        await observer.DisposeAsync();
        await observer.DisposeAsync(); // second dispose is a no-op
    }

    // ================================================================
    // TransparencyLogChecker — empty body response
    // ================================================================

    [Fact]
    public async Task TransparencyLogChecker_EmptyBody_ReturnsNotIncluded()
    {
        var opts = new SkewManifestOptions
        {
            ManifestUrl = "https://example.test/m.json",
            TransparencyLogUrl = "https://tlog.example.test/check",
        };
        var monitor = new FakeOptionsMonitor<SkewManifestOptions>(opts);
        var http = new StubHttpClientFactory(new StubHandler(_ =>
            new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("null", System.Text.Encoding.UTF8, "application/json"),
            }));
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var checker = new TransparencyLogChecker(http, clock, monitor);
        var (manifest, _, _) = ManifestFactory.BuildSigned();

        var result = await checker.CheckAsync(manifest, CancellationToken.None);

        Assert.False(result.Included);
        Assert.Contains("Empty", result.FailureReason);
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static SkewManifestObserver BuildObserver(
        SkewManifestOptions opts,
        InMemoryClock clock,
        HttpMessageHandler handler) =>
        new(
            new StubHttpClientFactory(handler),
            new StubFileSystem(),
            clock,
            new RecordingAuditLog(),
            new RecordingEventBus(),
            new FakeOptionsMonitor<SkewManifestOptions>(opts),
            NullLogger<SkewManifestObserver>.Instance);

    private static HttpResponseMessage Json(string content) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(content, System.Text.Encoding.UTF8, "application/json"),
    };
}
