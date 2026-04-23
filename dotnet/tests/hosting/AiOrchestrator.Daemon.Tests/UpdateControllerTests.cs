// <copyright file="UpdateControllerTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.IO.Pipelines;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Audit.Crypto;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Daemon;
using AiOrchestrator.Daemon.PidFile;
using AiOrchestrator.Daemon.Update;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class UpdateControllerTests : IDisposable
{
    private readonly string tmpRoot;

    public UpdateControllerTests()
    {
        var repoRoot = FindRepoRoot();
        this.tmpRoot = Path.Combine(repoRoot, ".orchestrator", "tmp", "daemon-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tmpRoot);
    }

    public void Dispose()
    {
        try { Directory.Delete(this.tmpRoot, recursive: true); } catch { }
    }

    [Fact]
    [ContractTest("UPD-RB-1")]
    public async Task UPD_RB_1_PollsAtConfiguredInterval()
    {
        var (controller, _, _, http) = this.MakeController(out var optsMon, ttlMs: 30);
        // Manifest URL returns 404 → fetch throws → CheckAndApplyAsync returns Failed_Network.
        http.Override = _ => new HttpResponseMessage(HttpStatusCode.NotFound);

        await controller.StartAsync(CancellationToken.None);
        await Task.Delay(250);
        await controller.StopAsync(CancellationToken.None);

        Assert.True(controller.CheckCount >= 2);
    }

    [Fact]
    [ContractTest("UPD-RB-2")]
    public async Task UPD_RB_2_RejectsManifestWithBadSignature()
    {
        var (controller, audit, _, http) = this.MakeController(out var optsMon, ttlMs: 60_000);
        var keys = NewKeyPair();

        // Build a manifest, but sign with a *different* key than the configured offlineRootPubKey.
        var attackerKeys = NewKeyPair();
        var (mfst, json) = BuildAndSignManifest(new Version(99, 0, 0), new Version(0, 0, 1), attackerKeys.priv, sigCount: 3);
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(json);
        optsMon.Set(optsMon.CurrentValue with { OfflineRootPubKey = keys.pub });

        var outcome = await controller.CheckAndApplyAsync(CancellationToken.None);

        Assert.Equal(UpdateOutcome.Rejected_BadSignature, outcome);
        Assert.Contains(audit.Records, r => r.EventType == "DaemonUpdateRejected");
    }

    [Fact]
    [ContractTest("UPD-RB-3")]
    public async Task UPD_RB_3_HealthFailureTriggersRollback()
    {
        var keys = NewKeyPair();
        var artifactBytes = Encoding.UTF8.GetBytes("hello-world");
        var artifact = new DaemonArtifact
        {
            Filename = "aio-daemon",
            Sha256 = Convert.ToHexString(SHA256.HashData(artifactBytes)).ToLowerInvariant(),
            Bytes = artifactBytes.Length,
            DownloadUrl = new Uri("https://example.test/aio-daemon"),
        };

        var (mfst, json) = BuildAndSignManifest(new Version(99, 0, 0), new Version(0, 0, 1), keys.priv, sigCount: 3, artifacts: ImmutableArray.Create(artifact));

        var spawner = new FakeProcessSpawner { ExitCode = 1 };
        var (controller, audit, _, http) = this.MakeController(out var optsMon, ttlMs: 60_000, spawner: spawner);
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(json);
        http.Responses[artifact.DownloadUrl.ToString()] = artifactBytes;

        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "install"));
        var stagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "staging"));
        Directory.CreateDirectory(installRoot.Value);
        File.WriteAllText(Path.Combine(installRoot.Value, "marker.txt"), "v1");
        optsMon.Set(optsMon.CurrentValue with
        {
            OfflineRootPubKey = keys.pub,
            InstallRoot = installRoot,
            UpdateStagingRoot = stagingRoot,
            DaemonExecutable = new AbsolutePath(Path.Combine(installRoot.Value, "aio-daemon")),
        });

        var outcome = await controller.CheckAndApplyAsync(CancellationToken.None);

        Assert.Equal(UpdateOutcome.RolledBack, outcome);
        Assert.Contains(audit.Records, r => r.EventType == "DaemonUpdateRolledBack");
        Assert.Equal("v1", File.ReadAllText(Path.Combine(installRoot.Value, "marker.txt")));
    }

    [Fact]
    [ContractTest("UPD-RB-4-REG")]
    public async Task UPD_RB_4_VersionRegressionRejected()
    {
        var keys = NewKeyPair();
        var (_, json) = BuildAndSignManifest(new Version(0, 0, 1), new Version(0, 0, 1), keys.priv, sigCount: 3);

        var (controller, audit, _, http) = this.MakeController(out var optsMon, ttlMs: 60_000);
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(json);
        optsMon.Set(optsMon.CurrentValue with { OfflineRootPubKey = keys.pub });

        var outcome = await controller.CheckAndApplyAsync(CancellationToken.None);

        Assert.Equal(UpdateOutcome.Rejected_VersionRegression, outcome);
        Assert.Contains(audit.Records, r => r.EventType == "DaemonUpdateRejected");
    }

    [Fact]
    [ContractTest("UPD-RB-4-DG")]
    public async Task UPD_RB_4_DowngradeBlocked()
    {
        var keys = NewKeyPair();
        // Current daemon assembly version is 1.0.0.0, MinSupported = 50.0.0 → blocks.
        var (_, json) = BuildAndSignManifest(new Version(99, 0, 0), new Version(50, 0, 0), keys.priv, sigCount: 3);

        var (controller, audit, _, http) = this.MakeController(out var optsMon, ttlMs: 60_000);
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(json);
        optsMon.Set(optsMon.CurrentValue with { OfflineRootPubKey = keys.pub });

        var outcome = await controller.CheckAndApplyAsync(CancellationToken.None);

        Assert.Equal(UpdateOutcome.Rejected_DowngradeBlocked, outcome);
        Assert.Contains(audit.Records, r => r.EventType == "DaemonUpdateRejected");
    }

    [Fact]
    [ContractTest("UPD-RB-5")]
    public async Task UPD_RB_5_AuditedOnEveryOutcome()
    {
        // Trigger several outcomes back-to-back and verify each emits an audit record.
        var keys = NewKeyPair();

        // 1) Applied
        var artifactBytes = Encoding.UTF8.GetBytes("daemon-bytes");
        var artifact = new DaemonArtifact
        {
            Filename = "aio-daemon",
            Sha256 = Convert.ToHexString(SHA256.HashData(artifactBytes)).ToLowerInvariant(),
            Bytes = artifactBytes.Length,
            DownloadUrl = new Uri("https://example.test/aio-daemon"),
        };
        var (_, jsonGood) = BuildAndSignManifest(new Version(99, 0, 0), new Version(0, 0, 1), keys.priv, sigCount: 3, artifacts: ImmutableArray.Create(artifact));

        var spawner = new FakeProcessSpawner { ExitCode = 0 };
        var (controller, audit, _, http) = this.MakeController(out var optsMon, ttlMs: 60_000, spawner: spawner);
        var installRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "install"));
        var stagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "staging"));
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(jsonGood);
        http.Responses[artifact.DownloadUrl.ToString()] = artifactBytes;
        optsMon.Set(optsMon.CurrentValue with
        {
            OfflineRootPubKey = keys.pub,
            InstallRoot = installRoot,
            UpdateStagingRoot = stagingRoot,
            DaemonExecutable = new AbsolutePath(Path.Combine(installRoot.Value, "aio-daemon")),
        });

        Assert.Equal(UpdateOutcome.Applied, await controller.CheckAndApplyAsync(CancellationToken.None));
        Assert.Contains(audit.Records, r => r.EventType == "DaemonUpdateApplied");

        // 2) Rejected_VersionRegression
        var (_, jsonReg) = BuildAndSignManifest(new Version(0, 0, 1), new Version(0, 0, 1), keys.priv, sigCount: 3);
        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(jsonReg);
        Assert.Equal(UpdateOutcome.Rejected_VersionRegression, await controller.CheckAndApplyAsync(CancellationToken.None));

        var distinctTypes = audit.Records.Select(r => r.EventType).Distinct();
        Assert.Contains("DaemonUpdateApplied", distinctTypes);
        Assert.Contains("DaemonUpdateRejected", distinctTypes);
    }

    [Fact]
    [ContractTest("UPD-RB-6")]
    public async Task UPD_RB_6_BuildKeyRolloverObservedOnNewKeys()
    {
        var keys = NewKeyPair();
        var keysetA = ImmutableArray.Create(NewKeyPair().pub, NewKeyPair().pub);
        var keysetB = ImmutableArray.Create(NewKeyPair().pub, NewKeyPair().pub);

        var (_, jsonA) = BuildAndSignManifest(new Version(0, 0, 1), new Version(0, 0, 1), keys.priv, sigCount: 3, trustedKeys: keysetA);
        var (_, jsonB) = BuildAndSignManifest(new Version(0, 0, 1), new Version(0, 0, 1), keys.priv, sigCount: 3, trustedKeys: keysetB);

        var (controller, _, bus, http) = this.MakeController(out var optsMon, ttlMs: 60_000);
        optsMon.Set(optsMon.CurrentValue with { OfflineRootPubKey = keys.pub });

        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(jsonA);
        await controller.CheckAndApplyAsync(CancellationToken.None);
        Assert.Empty(bus.Published.OfType<BuildKeyRolloverObserved>());

        http.Responses[optsMon.CurrentValue.ReleaseManifestUrl] = Encoding.UTF8.GetBytes(jsonB);
        await controller.CheckAndApplyAsync(CancellationToken.None);
        Assert.Single(bus.Published.OfType<BuildKeyRolloverObserved>());
    }

    [Fact]
    [ContractTest("UPD-RB-7")]
    public async Task UPD_RB_7_PidFileAtomicAndConflictDetected()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);
        var path = new AbsolutePath(Path.Combine(this.tmpRoot, "test.pid"));

        // Atomic: write went via tmp + MoveAtomic (no leftover tmp file in final state).
        await writer.WriteAsync(path, 12345, CancellationToken.None);
        Assert.True(fs.Files.ContainsKey(path.Value));
        Assert.Empty(fs.Files.Keys.Where(k => k.Contains(".tmp-", StringComparison.Ordinal)));
        Assert.Equal("12345", Encoding.UTF8.GetString(fs.Files[path.Value]).Trim());

        // Conflict: write current PID, then AcquireOrThrowAsync should fail.
        await writer.WriteAsync(path, Environment.ProcessId, CancellationToken.None);
        await Assert.ThrowsAsync<InvalidOperationException>(() => writer.AcquireOrThrowAsync(path, CancellationToken.None).AsTask());
    }

    [Fact]
    [ContractTest("DAEMON-DRAIN")]
    public async Task DAEMON_GRACEFUL_DrainsOnSigterm()
    {
        var (controller, _, _, http) = this.MakeController(out var optsMon, ttlMs: 30);
        http.Override = _ => new HttpResponseMessage(HttpStatusCode.NotFound);

        await controller.StartAsync(CancellationToken.None);
        await Task.Delay(80);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        await controller.StopAsync(CancellationToken.None);
        sw.Stop();

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
    }

    private (UpdateController c, InMemoryAuditLog audit, InMemoryEventBus bus, FakeHttpMessageHandler http)
        MakeController(out StaticOptionsMonitor<DaemonOptions> optsMon, int ttlMs, FakeProcessSpawner? spawner = null)
    {
        var http = new FakeHttpMessageHandler();
        var factory = new FakeHttpClientFactory(http);
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var audit = new InMemoryAuditLog();
        var bus = new InMemoryEventBus();
        spawner ??= new FakeProcessSpawner { ExitCode = 0 };

        var opts = new DaemonOptions
        {
            ReleaseManifestUrl = "https://example.test/release-manifest.signed.json",
            UpdateCheckInterval = TimeSpan.FromMilliseconds(ttlMs),
            InstallRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "install")),
            UpdateStagingRoot = new AbsolutePath(Path.Combine(this.tmpRoot, "staging")),
        };
        optsMon = new StaticOptionsMonitor<DaemonOptions>(opts);

        var fetcher = new ReleaseManifestFetcher(factory, NullLogger<ReleaseManifestFetcher>.Instance);
        var swap = new StagedSwap(clock, NullLogger<StagedSwap>.Instance);
        var health = new HealthCheck(spawner, NullLogger<HealthCheck>.Instance);
        var ctl = new UpdateController(factory, fs, clock, audit, bus, optsMon, NullLogger<UpdateController>.Instance, fetcher, swap, health);
        return (ctl, audit, bus, http);
    }

    private static (byte[] priv, byte[] pub) NewKeyPair()
    {
        EcdsaSigner.GenerateKeyPair(out var priv, out var pub);
        return (priv, pub);
    }

    private static (SignedReleaseManifest mfst, string json) BuildAndSignManifest(
        Version version,
        Version minSupported,
        byte[] privateKey,
        int sigCount,
        ImmutableArray<DaemonArtifact>? artifacts = null,
        ImmutableArray<byte[]>? trustedKeys = null)
    {
        var arts = artifacts ?? ImmutableArray<DaemonArtifact>.Empty;
        var keys = trustedKeys ?? ImmutableArray<byte[]>.Empty;
        var unsigned = new SignedReleaseManifest
        {
            Version = version,
            MinSupportedVersion = minSupported,
            SignedAt = DateTimeOffset.FromUnixTimeSeconds(1700000000),
            Artifacts = arts,
            Signatures = ImmutableArray<HsmSignature>.Empty,
            TrustedAuditPubKeys = keys,
        };
        var payload = ReleaseManifestFetcher.CanonicalPayload(unsigned);
        var signer = new EcdsaSigner();
        var sigs = Enumerable.Range(0, sigCount)
            .Select(i => new HsmSignature
            {
                KeyId = "hsm-" + i.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Signature = signer.Sign(payload, privateKey),
            })
            .ToImmutableArray();

        var mfst = unsigned with { Signatures = sigs };

        var dto = new
        {
            Version = version.ToString(),
            MinSupportedVersion = minSupported.ToString(),
            SignedAtUnix = unsigned.SignedAt.ToUnixTimeSeconds(),
            Artifacts = arts.Select(a => new
            {
                a.Filename,
                a.Sha256,
                a.Bytes,
                DownloadUrl = a.DownloadUrl.ToString(),
            }).ToArray(),
            Signatures = sigs.Select(s => new { s.KeyId, s.Signature }).ToArray(),
            TrustedAuditPubKeys = keys.ToArray(),
        };
        var json = JsonSerializer.Serialize(dto);
        return (mfst, json);
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "dotnet", "AiOrchestrator.slnx")))
        {
            dir = Path.GetDirectoryName(dir);
        }

        return dir ?? AppContext.BaseDirectory;
    }
}

internal sealed class FakeProcessSpawner : IProcessSpawner
{
    public int ExitCode { get; set; }

    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
        => ValueTask.FromResult<IProcessHandle>(new FakeHandle(this.ExitCode));

    private sealed class FakeHandle : IProcessHandle
    {
        private readonly int exit;
        private readonly Pipe stdoutPipe = new();
        private readonly Pipe stderrPipe = new();
        private readonly Pipe stdinPipe = new();

        public FakeHandle(int exit)
        {
            this.exit = exit;
            this.stdoutPipe.Writer.Complete();
            this.stderrPipe.Writer.Complete();
        }

        public int ProcessId => 0;

        public PipeReader StandardOut => this.stdoutPipe.Reader;

        public PipeReader StandardError => this.stderrPipe.Reader;

        public PipeWriter StandardIn => this.stdinPipe.Writer;

        public Task<int> WaitForExitAsync(CancellationToken ct) => Task.FromResult(this.exit);

        public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct) => ValueTask.CompletedTask;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
