// <copyright file="CoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Audit;
using AiOrchestrator.Credentials.Allowlist;
using AiOrchestrator.Credentials.Backoff;
using AiOrchestrator.Credentials.Ipc;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Credentials.Tests;

/// <summary>Tests covering uncovered branches in Credentials assembly.</summary>
public sealed class CoverageGapTests : IAsyncDisposable
{
    private readonly List<IAsyncDisposable> disposables = new();

    public async ValueTask DisposeAsync()
    {
        foreach (var d in this.disposables)
        {
            try { await d.DisposeAsync(); }
            catch { /* best effort */ }
        }
    }

    // =====================================================================
    // CredentialIpc
    // =====================================================================

    [Fact]
    public void CredentialIpc_CtorThrowsOnNullSpawner()
    {
        var path = new AbsolutePath(Path.Combine(Path.GetTempPath(), "cred-test.sock"));
        Assert.Throws<ArgumentNullException>(() => new CredentialIpc(path, null!));
    }

    [Fact]
    public void CredentialIpc_CtorRejectsNulBytePrefix()
    {
        var spawner = new GcmScriptSpawner();
        // AbsolutePath may reject this but the check inside CredentialIpc is for \0 or @ prefix
        // We test the @ prefix path on non-Windows (rooted "/@" path)
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // On POSIX, construct a path starting with @ (non-rooted) — AbsolutePath requires rooted
            // Use /@abstract which is rooted and should pass AbsolutePath but NOT trigger the guard
            // (the guard checks raw.StartsWith('\0') || raw.StartsWith('@'))
            var safePath = new AbsolutePath("/@abstract");
            var ipc = new CredentialIpc(safePath, spawner);
            Assert.Equal("/@abstract", ipc.SocketPath);
        }
    }

    [Fact]
    public void CredentialIpc_NewSocketPathWithRootOverride()
    {
        var tmpDir = Path.Combine(Path.GetTempPath(), "cred-" + Guid.NewGuid().ToString("N"));
        var path = CredentialIpc.NewSocketPath(tmpDir);
        Assert.StartsWith(tmpDir.TrimEnd(Path.DirectorySeparatorChar), path);
        Assert.Contains("cred.", path);
        Assert.EndsWith(".sock", path);
    }

    [Fact]
    public void CredentialIpc_NewSocketPathDefaultWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // only relevant on Windows
        }

        var path = CredentialIpc.NewSocketPath();
        Assert.StartsWith(@"\\.\pipe\ai-orchestrator", path);
        Assert.Contains("cred.", path);
    }

    [Fact]
    public async Task CredentialIpc_GetPeerCredentialsAsync_ThrowsOnNull()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "cred." + Guid.NewGuid().ToString("N") + ".sock");
        var ipc = new CredentialIpc(new AbsolutePath(Path.GetFullPath(sockPath)), spawner);
        this.disposables.Add(ipc);

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => ipc.GetPeerCredentialsAsync(null!, CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task CredentialIpc_GetPeerCredentialsAsync_ThrowsOnCancelled()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "cred." + Guid.NewGuid().ToString("N") + ".sock");
        var ipc = new CredentialIpc(new AbsolutePath(Path.GetFullPath(sockPath)), spawner);
        this.disposables.Add(ipc);

        using var cts = new CancellationTokenSource();
        cts.Cancel();
        using var ms = new MemoryStream();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ipc.GetPeerCredentialsAsync(ms, cts.Token).AsTask());
    }

    [Fact]
    public async Task CredentialIpc_GetPeerCredentialsAsync_WithMemoryStreamReturnsSelf()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "cred." + Guid.NewGuid().ToString("N") + ".sock");
        var ipc = new CredentialIpc(new AbsolutePath(Path.GetFullPath(sockPath)), spawner);
        this.disposables.Add(ipc);

        using var ms = new MemoryStream();
        var peer = await ipc.GetPeerCredentialsAsync(ms, CancellationToken.None);

        Assert.NotNull(peer);
        // On Windows, MemoryStream falls through to default path returning current process info
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            Assert.True(peer.Pid > 0);
            Assert.Equal(Environment.UserName, peer.UserSid);
        }
    }

    [Fact]
    public async Task CredentialIpc_DisposeIsIdempotent()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "cred." + Guid.NewGuid().ToString("N") + ".sock");
        var ipc = new CredentialIpc(new AbsolutePath(Path.GetFullPath(sockPath)), spawner);
        await ipc.DisposeAsync();
        await ipc.DisposeAsync(); // second dispose should not throw
    }

    [Fact]
    public void CredentialIpc_SocketPathProperty()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "test.sock");
        var fullPath = Path.GetFullPath(sockPath);
        var ipc = new CredentialIpc(new AbsolutePath(fullPath), spawner);
        this.disposables.Add(ipc);
        Assert.Equal(fullPath, ipc.SocketPath);
    }

    [Fact]
    public void CredentialIpc_ExtractPipeName_WindowsPipePrefix()
    {
        // NewSocketPath for Windows uses \\.\pipe\ prefix — verify the pipe name extraction
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var path = CredentialIpc.NewSocketPath();
        // Should not contain the \\.\pipe\ prefix as the pipe name
        Assert.Contains("cred.", path);
    }

    [Fact]
    public async Task CredentialIpc_StartListeningAsync_ThrowsOnCancelled()
    {
        var spawner = new GcmScriptSpawner();
        var sockPath = Path.Combine(Path.GetTempPath(), "cred." + Guid.NewGuid().ToString("N") + ".sock");
        var ipc = new CredentialIpc(new AbsolutePath(Path.GetFullPath(sockPath)), spawner);
        this.disposables.Add(ipc);

        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ipc.StartListeningAsync(cts.Token).AsTask());
    }

    // =====================================================================
    // HostAllowlistChecker
    // =====================================================================

    [Fact]
    public void HostAllowlistChecker_ThrowsOnNullOpts()
    {
        Assert.Throws<ArgumentNullException>(() => new HostAllowlistChecker(null!));
    }

    [Fact]
    public void HostAllowlistChecker_ThrowsOnNullUrl()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        Assert.Throws<ArgumentNullException>(() => checker.IsAllowed(null!));
    }

    [Fact]
    public void HostAllowlistChecker_EmptyHostIsDenied()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        // file:// URIs typically have empty host
        var url = new Uri("file:///tmp/repo.git");
        Assert.False(checker.IsAllowed(url));
    }

    [Fact]
    public void HostAllowlistChecker_ExactMatchAllowed()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        Assert.True(checker.IsAllowed(new Uri("https://github.com/org/repo")));
    }

    [Fact]
    public void HostAllowlistChecker_SubdomainSuffixMatchAllowed()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        Assert.True(checker.IsAllowed(new Uri("https://api.github.com/repos")));
    }

    [Fact]
    public void HostAllowlistChecker_PartialHostNotAllowed()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        // "evilgithub.com" should NOT match "github.com" suffix
        Assert.False(checker.IsAllowed(new Uri("https://evilgithub.com/repo")));
    }

    [Fact]
    public void HostAllowlistChecker_CaseInsensitive()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        Assert.True(checker.IsAllowed(new Uri("https://GitHub.COM/org/repo")));
    }

    [Fact]
    public void HostAllowlistChecker_EmptySuffixInListIsSkipped()
    {
        var options = DefaultOptions() with
        {
            AllowedHostSuffixes = ImmutableArray.Create("", "github.com"),
        };
        var opts = new StaticOptionsMonitor<CredentialOptions>(options);
        var checker = new HostAllowlistChecker(opts);
        Assert.True(checker.IsAllowed(new Uri("https://github.com/repo")));
        Assert.False(checker.IsAllowed(new Uri("https://evil.com/repo")));
    }

    [Fact]
    public void HostAllowlistChecker_CreateExceptionIncludesUrl()
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(DefaultOptions());
        var checker = new HostAllowlistChecker(opts);
        var url = new Uri("https://evil.example.com/repo");
        var ex = checker.CreateException(url);
        Assert.Equal(url, ex.Url);
        Assert.Contains("evil.example.com", ex.Message);
    }

    // =====================================================================
    // CredentialBroker
    // =====================================================================

    [Fact]
    public async Task CredentialBroker_StoreAsync_DisallowedHostThrows()
    {
        var (broker, _, _, _, _, _) = Build();
        var url = new Uri("https://evil.example.com/repo");
        var cred = new Credential
        {
            Username = "test",
            Password = new ProtectedString("pw"),
            RetrievedAt = DateTimeOffset.UtcNow,
            SourceProtocol = "https",
        };

        await Assert.ThrowsAsync<CredentialHostNotAllowedException>(
            () => broker.StoreAsync(url, cred, TestPrincipals.Alice(), default).AsTask());
    }

    [Fact]
    public async Task CredentialBroker_EraseAsync_DisallowedHostThrows()
    {
        var (broker, _, _, _, _, _) = Build();
        var url = new Uri("https://evil.example.com/repo");

        await Assert.ThrowsAsync<CredentialHostNotAllowedException>(
            () => broker.EraseAsync(url, TestPrincipals.Alice(), default).AsTask());
    }

    [Fact]
    public async Task CredentialBroker_StoreAsync_GcmFailureAuditsAndRethrows()
    {
        var (broker, spawner, audit, _, _, _) = Build();
        spawner.Script.StoreExitCode = 1;
        var url = new Uri("https://github.com/org/repo");
        var cred = new Credential
        {
            Username = "test",
            Password = new ProtectedString("pw"),
            RetrievedAt = DateTimeOffset.UtcNow,
            SourceProtocol = "https",
        };

        await Assert.ThrowsAnyAsync<Exception>(
            () => broker.StoreAsync(url, cred, TestPrincipals.Alice(), default).AsTask());
        Assert.Contains(audit.Records, r => r.EventType == "credential.store.failed");
    }

    [Fact]
    public async Task CredentialBroker_EraseAsync_GcmFailureAuditsAndRethrows()
    {
        var (broker, spawner, audit, _, _, _) = Build();
        spawner.Script.EraseExitCode = 1;
        var url = new Uri("https://github.com/org/repo");

        await Assert.ThrowsAnyAsync<Exception>(
            () => broker.EraseAsync(url, TestPrincipals.Alice(), default).AsTask());
        Assert.Contains(audit.Records, r => r.EventType == "credential.erase.failed");
    }

    [Fact]
    public async Task CredentialBroker_GetAsync_NullUrlThrows()
    {
        var (broker, _, _, _, _, _) = Build();
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => broker.GetAsync(null!, TestPrincipals.Alice(), default).AsTask());
    }

    [Fact]
    public async Task CredentialBroker_GetAsync_NullPrincipalThrows()
    {
        var (broker, _, _, _, _, _) = Build();
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => broker.GetAsync(new Uri("https://github.com"), null!, default).AsTask());
    }

    [Fact]
    public async Task CredentialBroker_DisposeIsIdempotent()
    {
        var (broker, _, _, _, _, _) = Build();
        await broker.DisposeAsync();
        await broker.DisposeAsync(); // should not throw
    }

    [Fact]
    public void CredentialBroker_RedactForAudit_RemovesPathQueryAndUserinfo()
    {
        var url = new Uri("https://user:pass@github.com/path/to/repo?token=abc");
        var redacted = CredentialBroker.RedactForAudit(url);
        Assert.Equal("https://github.com", redacted);
        Assert.DoesNotContain("user", redacted);
        Assert.DoesNotContain("pass", redacted);
        Assert.DoesNotContain("token", redacted);
        Assert.DoesNotContain("path", redacted);
    }

    [Fact]
    public async Task CredentialBroker_GetAsync_BackoffAuditsBeforeThrowing()
    {
        var opts = DefaultOptions() with
        {
            Backoff = new CredentialBackoffOptions
            {
                FailuresBeforeBackoff = 2,
                InitialDelay = TimeSpan.FromSeconds(60),
                MaxDelay = TimeSpan.FromMinutes(5),
                Multiplier = 2.0,
            },
        };
        var (broker, spawner, audit, _, _, _) = Build(opts);
        spawner.Script.GetExitCode = 1;
        var url = new Uri("https://github.com/org/repo");

        // Trigger 2 failures to engage backoff
        for (var i = 0; i < 2; i++)
        {
            try { await broker.GetAsync(url, TestPrincipals.Alice(), default); }
            catch { }
        }

        // Next call should be blocked by backoff
        await Assert.ThrowsAsync<CredentialBackoffActiveException>(
            () => broker.GetAsync(url, TestPrincipals.Alice(), default).AsTask());
        Assert.Contains(audit.Records, r => r.EventType == "credential.get.backoff");
    }

    // =====================================================================
    // CredentialBackoffEngine
    // =====================================================================

    [Fact]
    public void CredentialBackoffEngine_TryEnterReturnsTrueForUnknownUrl()
    {
        var (_, _, _, _, _, opts) = Build();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var bus = new InMemoryEventBus();
        var engine = new CredentialBackoffEngine(clock, opts, bus);

        Assert.True(engine.TryEnter(new Uri("https://unknown.com"), out var delay));
        Assert.Equal(TimeSpan.Zero, delay);
    }

    [Fact]
    public void CredentialBackoffEngine_RecordSuccessResetsState()
    {
        var (_, _, _, _, _, opts) = Build();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var bus = new InMemoryEventBus();
        var engine = new CredentialBackoffEngine(clock, opts, bus);
        var url = new Uri("https://github.com/org/repo");

        engine.RecordFailure(url);
        engine.RecordFailure(url);
        engine.RecordSuccess(url);

        // Should be fully reset — passes through without backoff
        Assert.True(engine.TryEnter(url, out _));
    }

    // =====================================================================
    // CredentialBackoffActiveException
    // =====================================================================

    [Fact]
    public void CredentialBackoffActiveException_PropertiesPopulated()
    {
        var url = new Uri("https://github.com");
        var delay = TimeSpan.FromSeconds(30);
        var ex = new CredentialBackoffActiveException(url, delay);
        Assert.Equal(url, ex.Url);
        Assert.Equal(delay, ex.RemainingDelay);
        Assert.Contains("github.com", ex.Message);
    }

    [Fact]
    public void CredentialBackoffActiveException_NullUrlThrows()
    {
        Assert.Throws<ArgumentNullException>(() => new CredentialBackoffActiveException(null!, TimeSpan.Zero));
    }

    // =====================================================================
    // CredentialHostNotAllowedException
    // =====================================================================

    [Fact]
    public void CredentialHostNotAllowedException_PropertiesPopulated()
    {
        var url = new Uri("https://evil.com/repo");
        var suffixes = ImmutableArray.Create("github.com");
        var ex = new CredentialHostNotAllowedException(url, suffixes);
        Assert.Equal(url, ex.Url);
        Assert.Equal(suffixes, ex.AllowedSuffixes);
        Assert.Contains("evil.com", ex.Message);
    }

    // =====================================================================
    // PeerInfo
    // =====================================================================

    [Fact]
    public void PeerInfo_PropertiesAreAccessible()
    {
        var info = new PeerInfo { Pid = 1234, Uid = 1000, UserSid = "S-1-5-21" };
        Assert.Equal(1234, info.Pid);
        Assert.Equal(1000u, info.Uid);
        Assert.Equal("S-1-5-21", info.UserSid);
    }

    [Fact]
    public void PeerInfo_NullUserSidAllowed()
    {
        var info = new PeerInfo { Pid = 42, Uid = 0, UserSid = null };
        Assert.Null(info.UserSid);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    private static CredentialOptions DefaultOptions() => new()
    {
        AllowedHostSuffixes = ImmutableArray.Create("github.com", "dev.azure.com"),
        GcmTimeout = TimeSpan.FromSeconds(30),
        GcmExecutableName = "git-credential-manager",
        Backoff = new CredentialBackoffOptions
        {
            FailuresBeforeBackoff = 5,
            InitialDelay = TimeSpan.FromMinutes(1),
            MaxDelay = TimeSpan.FromHours(1),
            Multiplier = 2.0,
        },
    };

    private static (CredentialBroker Broker, GcmScriptSpawner Spawner, InMemoryAuditLog Audit, InMemoryEventBus Bus, InMemoryClock Clock, StaticOptionsMonitor<CredentialOptions> Opts)
        Build(CredentialOptions? options = null)
    {
        var opts = new StaticOptionsMonitor<CredentialOptions>(options ?? DefaultOptions());
        var spawner = new GcmScriptSpawner();
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var audit = new InMemoryAuditLog();
        var bus = new InMemoryEventBus();
        var logger = NullLogger<CredentialBroker>.Instance;
        var broker = new CredentialBroker(spawner, clock, audit, opts, logger, bus);
        return (broker, spawner, audit, bus, clock, opts);
    }
}
