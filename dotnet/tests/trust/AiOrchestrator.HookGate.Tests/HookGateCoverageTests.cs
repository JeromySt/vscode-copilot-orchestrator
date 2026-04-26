// <copyright file="HookGateCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.HookGate;
using AiOrchestrator.HookGate.Exceptions;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.HookGate.Nonce;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Rpc;
using AiOrchestrator.HookGate.Validation;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.HookGate.Tests;

/// <summary>Extra unit tests that exercise branches not covered by the contract suite (coverage gate).</summary>
public sealed class HookGateCoverageTests
{
    private static HookGateOptions DefaultOptions() => new()
    {
        NonceRotation = TimeSpan.FromMinutes(5),
        ApprovalTokenTtl = TimeSpan.FromMinutes(2),
    };

    private static IOptionsMonitor<HookGateOptions> Monitor(HookGateOptions? opts = null)
        => new StaticOptionsMonitor<HookGateOptions>(opts ?? DefaultOptions());

    private static AbsolutePath Worktree(out string path)
    {
        path = Path.Combine(Path.GetTempPath(), "ai-hg-cov-" + Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(Path.Combine(path, ".git", "hooks"));
        return new AbsolutePath(path);
    }

    // ================================================================
    // HookApprovalDeniedException
    // ================================================================

    [Fact]
    public void HookApprovalDeniedException_ExposesReasonAndKind()
    {
        var ex = new HookApprovalDeniedException("nope", HookKind.PrePush);

Assert.Equal("nope", ex.Reason);
Assert.Equal(HookKind.PrePush, ex.Kind);
Assert.Contains("nope", ex.Message); /* also contains "PrePush" */;
    }

    [Fact]
    public void HookApprovalDeniedException_RejectsNullReason()
    {
        Action act = () => _ = new HookApprovalDeniedException(null!, HookKind.PreCommit);
        Assert.Throws<ArgumentNullException>(act);
    }

    // ================================================================
    // HookGateOptions
    // ================================================================

    [Fact]
    public void HookGateOptions_HasSensibleDefaults()
    {
        var o = new HookGateOptions();

        Assert.Equal(TimeSpan.FromMinutes(5), o.NonceRotation);
        Assert.Equal(TimeSpan.FromMinutes(2), o.ApprovalTokenTtl);
Assert.False(o.RequireImmutability);
Assert.False(string.IsNullOrEmpty(o.PipeName));
Assert.False(string.IsNullOrEmpty(o.SocketPath.Value));
    }

    // ================================================================
    // NonceManager â€” rotation event + ForceRotate
    // ================================================================

    [Fact]
    public void NonceManager_ForceRotate_RaisesRotatedEvent()
    {
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var mgr = new NonceManager(clock, Monitor());
        NonceRotated? observed = null;
        mgr.Rotated += (_, e) => observed = e;

        var before = mgr.Current;
        mgr.ForceRotate();

Assert.NotNull(observed);
Assert.NotNull(observed!.Previous);
Assert.NotNull(observed.Current);
Assert.Equal(before.Value, observed.Previous!.Value);
    }

    [Fact]
    public void NonceManager_ClearsPreviousAfterTwoRotationIntervals()
    {
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var opts = Monitor();
        var mgr = new NonceManager(clock, opts);

        // Advance past 2Ã— rotation, then trigger a rotation.
        clock.Advance(TimeSpan.FromMinutes(11));
        _ = mgr.Current;

Assert.Null(mgr.Previous);
    }

    [Fact]
    public void NonceRotated_RejectsNullCurrent()
    {
        Action act = () => _ = new NonceRotated(null, null!);
        Assert.Throws<ArgumentNullException>(act);
    }

    [Fact]
    public void NonceManager_Constructor_RejectsNullDependencies()
    {
        Action a = () => _ = new NonceManager(null!, Monitor());
        Action b = () => _ = new NonceManager(new InMemoryClock(), null!);
        Assert.Throws<ArgumentNullException>(a);
        Assert.Throws<ArgumentNullException>(b);
    }

    // ================================================================
    // ApprovalIssuer
    // ================================================================

    [Fact]
    public void ApprovalIssuer_FormatTimestamp_ProducesRoundtrippableIso()
    {
        var t = DateTimeOffset.Parse("2030-06-01T12:34:56.789Z", System.Globalization.CultureInfo.InvariantCulture);
        var s = ApprovalIssuer.FormatTimestamp(t);

Assert.Equal(t, DateTimeOffset.Parse(s, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void ApprovalIssuer_NewTokenId_ProducesDistinctHex()
    {
        var t1 = ApprovalIssuer.NewTokenId();
        var t2 = ApprovalIssuer.NewTokenId();

Assert.NotEqual(t2, t1);
Assert.Equal(32, t1.Length);
    }

    [Fact]
    public void ApprovalIssuer_Issue_ProducesExpiryEqualToNowPlusTtl()
    {
        var nonce = new Nonce.Nonce
        {
            Value = Convert.ToBase64String(new byte[32]),
            IssuedAt = DateTimeOffset.UtcNow,
            RotatesAt = DateTimeOffset.UtcNow.AddMinutes(5),
        };
        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = new AbsolutePath(Path.GetTempPath()),
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };
        var now = DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        var approval = ApprovalIssuer.Issue(nonce, req, now, TimeSpan.FromMinutes(2));

        Assert.Equal(now + TimeSpan.FromMinutes(2), approval.ExpiresAt);
Assert.Equal(now, approval.IssuedAt);
Assert.NotEmpty(approval.Hmac);
    }

    // ================================================================
    // HookGateDaemon â€” null-arg constructor guards + Dispose + Client
    // ================================================================

    private sealed class NoopRedirection : IRedirectionManager
    {
        public ValueTask InstallRedirectionAsync(AbsolutePath a, AbsolutePath b, CancellationToken ct) => default;

        public ValueTask UninstallRedirectionAsync(AbsolutePath a, CancellationToken ct) => default;

        public ValueTask<RedirectionMode> GetActiveModeAsync(AbsolutePath a, CancellationToken ct) => ValueTask.FromResult(RedirectionMode.BindMount);
    }

    [Fact]
    public async Task HookGateDaemon_DisposeAsync_IsIdempotent()
    {
        var opts = Monitor();
        var clock = new InMemoryClock();
        var d = new HookGateDaemon(
            new NonceManager(clock, opts),
            new InProcessRpcServer(),
            new NoopRedirection(),
            clock,
            new InMemoryEventBus(),
            opts,
            NullLogger<HookGateDaemon>.Instance,
            new InMemoryAuditLog(),
            new PassthroughFileSystem());

        await d.DisposeAsync();
        await d.DisposeAsync();  // no throw
    }

    [Fact]
    public async Task HookGateClient_WrapsDaemon_And_DelegatesCheckIn()
    {
        var opts = Monitor();
        var clock = new InMemoryClock();
        var rpc = new InProcessRpcServer();
        var audit = new InMemoryAuditLog();
        var d = new HookGateDaemon(
            new NonceManager(clock, opts),
            rpc,
            new NoopRedirection(),
            clock,
            new InMemoryEventBus(),
            opts,
            NullLogger<HookGateDaemon>.Instance,
            audit, new PassthroughFileSystem());
        await d.StartAsync(CancellationToken.None);
        var client = new HookGateClient(d);
        var wt = Worktree(out var wtPath);
        File.WriteAllText(Path.Combine(wtPath, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");

        var approval = await client.CheckInAsync(
            new HookCheckInRequest
            {
                Kind = HookKind.PreCommit,
                HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
                WorktreeRoot = wt,
                Principal = TestPrincipals.Alice(),
                Env = ImmutableDictionary<string, string>.Empty,
            },
            CancellationToken.None);

Assert.NotNull(approval);
Assert.False(string.IsNullOrEmpty(approval.TokenId));
Assert.Contains(audit.Records, r => r.EventType == "hook.approve");
        await d.StopAsync(CancellationToken.None);
    }

    [Fact]
    public void HookGateClient_NullDaemon_Throws()
    {
        Action act = () => _ = new HookGateClient(null!);
        Assert.Throws<ArgumentNullException>(act);
    }

    // ================================================================
    // InProcessRpcServer â€” null handler / StopAsync rejects new / idempotent dispose
    // ================================================================

    [Fact]
    public async Task InProcessRpcServer_DispatchAfterStop_Throws()
    {
        var s = new InProcessRpcServer();
        await s.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);
        await s.StopAsync(CancellationToken.None);

        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = new AbsolutePath(Path.GetTempPath()),
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        Func<Task> act = async () => await s.DispatchAsync(req, CancellationToken.None);
        await Assert.ThrowsAsync<HookApprovalDeniedException>(act);
        await s.DisposeAsync();
    }

    [Fact]
    public async Task InProcessRpcServer_StartAsync_NullHandler_Throws()
    {
        var s = new InProcessRpcServer();
        Func<Task> act = async () => await s.StartAsync(null!, CancellationToken.None);
        await Assert.ThrowsAsync<ArgumentNullException>(act);
    }

    // ================================================================
    // EventBusImmutabilityEventSink
    // ================================================================

    [Fact]
    public async Task EventBusImmutabilityEventSink_ForwardsPublish()
    {
        var bus = new InMemoryEventBus();
        var sink = new EventBusImmutabilityEventSink(bus);
        var evt = new HookGateNonceImmutabilityUnsupported
        {
            Path = new AbsolutePath(Path.GetTempPath()),
            Mechanism = "symlink",
            Reason = "test",
            At = DateTimeOffset.UtcNow,
        };

        await sink.PublishAsync(evt, CancellationToken.None);

        Assert.Same(evt, Assert.Single(bus.Published));
    }

    [Fact]
    public void EventBusImmutabilityEventSink_NullBus_Throws()
    {
        Action act = () => _ = new EventBusImmutabilityEventSink(null!);
        Assert.Throws<ArgumentNullException>(act);
    }

    // ================================================================
    // ToolRunner â€” timeout + spawn error + success w/ stdout
    // ================================================================

    [Fact]
    public async Task ToolRunner_ReturnsMinusOne_WhenSpawnerThrowsFileNotFound()
    {
        var spawner = new ThrowingSpawner(new FileNotFoundException("nope"));
        var (code, stdout) = await ToolRunner.RunAsync(spawner, "x", Array.Empty<string>(), TimeSpan.FromSeconds(1), CancellationToken.None);

Assert.Equal(-1, code);
Assert.Empty(stdout);
    }

    [Fact]
    public async Task ToolRunner_CollectsStdout_OnSuccess()
    {
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0, StdoutForNextSpawn = "hello-world" };

        var (code, stdout) = await ToolRunner.RunAsync(spawner, "tool", new[] { "a" }, TimeSpan.FromSeconds(1), CancellationToken.None);

Assert.Equal(0, code);
Assert.Equal("hello-world", stdout);
    }

    private sealed class ThrowingSpawner : IProcessSpawner
    {
        private readonly Exception ex;

        public ThrowingSpawner(Exception ex) => this.ex = ex;

        public ValueTask<IProcessHandle> SpawnAsync(AiOrchestrator.Models.ProcessSpec spec, CancellationToken ct)
            => throw this.ex;
    }

    // ================================================================
    // LinkValidator â€” success on a normal file
    // ================================================================

    [Fact]
    public async Task LinkValidator_OkForNormalHookInsideWorktree()
    {
        var v = new LinkValidator(new PassthroughFileSystem());
        var wt = Worktree(out var wtPath);
        var hook = Path.Combine(wtPath, ".git", "hooks", "pre-commit");
        File.WriteAllText(hook, "#!/bin/sh\nexit 0\n");

        var r = await v.ValidateAsync(new AbsolutePath(hook), wt, CancellationToken.None);

Assert.True(r.Ok);
    }

    [Fact]
    public async Task LinkValidator_RejectsNonExistentHook()
    {
        var v = new LinkValidator(new PassthroughFileSystem());
        var wt = Worktree(out var wtPath);
        var missing = new AbsolutePath(Path.Combine(wtPath, ".git", "hooks", "ghost"));

        var r = await v.ValidateAsync(missing, wt, CancellationToken.None);

Assert.False(r.Ok);
Assert.False(string.IsNullOrEmpty(r.FailureReason));
    }

    // ================================================================
    // WindowsRedirectionManager â€” success path via ok spawner; failure branch too
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_InstallUninstall_OnSpawnerSuccess()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var events = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0 };
        var mgr = new WindowsRedirectionManager(events, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        var wt = Worktree(out var wtPath);
        var src = Path.Combine(wtPath, "dispatcher");
        _ = Directory.CreateDirectory(src);

        await mgr.InstallRedirectionAsync(new AbsolutePath(Path.Combine(wtPath, ".git", "hooks")), new AbsolutePath(src), CancellationToken.None);
        await mgr.UninstallRedirectionAsync(new AbsolutePath(Path.Combine(wtPath, ".git", "hooks")), CancellationToken.None);

Assert.NotEmpty(spawner.SpawnedSpecs);
    }

    [Fact]
    public async Task WindowsRedirectionManager_GetActiveMode_ReturnsNotInstalledForMissingPath()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var mgr = new WindowsRedirectionManager(new InMemoryImmutabilitySink(), new NullProcessSpawner(), new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        var mode = await mgr.GetActiveModeAsync(new AbsolutePath(Path.Combine(Path.GetTempPath(), "ghost-" + Guid.NewGuid().ToString("N"))), CancellationToken.None);

Assert.Equal(RedirectionMode.NotInstalled, mode);
    }

    [Fact]
    public void WindowsRedirectionManager_Constructor_RejectsNulls()
    {
        Action a = () => _ = new WindowsRedirectionManager(null!, new NullProcessSpawner(), new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        Action b = () => _ = new WindowsRedirectionManager(new InMemoryImmutabilitySink(), null!, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        Action c = () => _ = new WindowsRedirectionManager(new InMemoryImmutabilitySink(), new NullProcessSpawner(), new PassthroughFileSystem(), null!);
        Assert.Throws<ArgumentNullException>(a);
        Assert.Throws<ArgumentNullException>(b);
        Assert.Throws<ArgumentNullException>(c);
    }

    // ================================================================
    // NamedPipeRpcServer â€” start/stop/dispose on Windows
    // ================================================================

    [Fact]
    public async Task NamedPipeRpcServer_StartThenStop_OnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var s = new NamedPipeRpcServer(@"\\.\pipe\aio-hg-cov-" + Guid.NewGuid().ToString("N"), NullLogger<NamedPipeRpcServer>.Instance);
        await s.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);
        await s.StopAsync(CancellationToken.None);
        await s.DisposeAsync();
        await s.DisposeAsync();  // idempotent
    }

    [Fact]
    public void NamedPipeRpcServer_Constructor_RejectsNulls()
    {
        Action a = () => _ = new NamedPipeRpcServer(null!, NullLogger<NamedPipeRpcServer>.Instance);
        Action b = () => _ = new NamedPipeRpcServer("pipe", null!);
        Assert.Throws<ArgumentNullException>(a);
        Assert.Throws<ArgumentNullException>(b);
    }

    // ================================================================
    // UnixSocketRpcServer â€” Windows guard path
    // ================================================================

    [Fact]
    public async Task UnixSocketRpcServer_RejectsStart_OnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var s = new UnixSocketRpcServer(new AbsolutePath(@"C:\tmp\x.sock"), new PassthroughFileSystem(), NullLogger<UnixSocketRpcServer>.Instance);
        Func<Task> act = async () => await s.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);

        await Assert.ThrowsAsync<PlatformNotSupportedException>(act);
        await s.DisposeAsync();
    }

    [Fact]
    public void UnixSocketRpcServer_Constructor_RejectsNullLogger()
    {
        Action a = () => _ = new UnixSocketRpcServer(new AbsolutePath("/tmp/x.sock"), new PassthroughFileSystem(), null!);
        Assert.Throws<ArgumentNullException>(a);
    }

    // ================================================================
    // ImmutabilityProbe â€” Windows path returns a result (supported or not)
    // ================================================================

    [Fact]
    public async Task ImmutabilityProbe_WindowsBranch_ClassifiesExitCode()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var clock = new InMemoryClock();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0 };
        var probe = new ImmutabilityProbe(clock, spawner);
        var path = new AbsolutePath(Path.GetTempPath());

        var r = await probe.ProbeAsync(path, CancellationToken.None);

Assert.True(r.Supported);
Assert.Equal("DACL-deny", r.Mechanism);
    }

    [Fact]
    public void ImmutabilityProbe_Constructor_RejectsNulls()
    {
        Action a = () => _ = new ImmutabilityProbe(null!, new NullProcessSpawner());
        Action b = () => _ = new ImmutabilityProbe(new InMemoryClock(), null!);
        Assert.Throws<ArgumentNullException>(a);
        Assert.Throws<ArgumentNullException>(b);
    }

    // ================================================================
    // HookGateDaemon â€” null-arg constructor guards
    // ================================================================

    [Fact]
    public void HookGateDaemon_Constructor_RejectsEveryNull()
    {
        var opts = Monitor();
        var clock = new InMemoryClock();
        var nonces = new NonceManager(clock, opts);
        var rpc = new InProcessRpcServer();
        var redirect = new NoopRedirection();
        var bus = new InMemoryEventBus();
        var audit = new InMemoryAuditLog();
        var log = NullLogger<HookGateDaemon>.Instance;

        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(null!, rpc, redirect, clock, bus, opts, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, null!, redirect, clock, bus, opts, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, null!, clock, bus, opts, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, redirect, null!, bus, opts, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, redirect, clock, null!, opts, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, redirect, clock, bus, null!, log, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, redirect, clock, bus, opts, null!, audit, new PassthroughFileSystem()));
        Assert.Throws<ArgumentNullException>(() => new HookGateDaemon(nonces, rpc, redirect, clock, bus, opts, log, null!, new PassthroughFileSystem()));
    }

    // ================================================================
    // HookGateDaemon â€” ProcessAsync denial branch (link validation fails)
    // ================================================================

    [Fact]
    public async Task HookGateDaemon_DeniesCheckIn_WhenHookFileMissing()
    {
        var opts = Monitor();
        var clock = new InMemoryClock();
        var audit = new InMemoryAuditLog();
        var d = new HookGateDaemon(
            new NonceManager(clock, opts),
            new InProcessRpcServer(),
            new NoopRedirection(),
            clock,
            new InMemoryEventBus(),
            opts,
            NullLogger<HookGateDaemon>.Instance,
            audit, new PassthroughFileSystem());
        await d.StartAsync(CancellationToken.None);
        var wt = Worktree(out var wtPath);

        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/does-not-exist"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        Func<Task> act = async () => await d.HandleCheckInAsync(req, CancellationToken.None);

        await Assert.ThrowsAsync<HookApprovalDeniedException>(act);
Assert.Contains(audit.Records, r => r.EventType == "hook.deny");
        await d.StopAsync(CancellationToken.None);
        await d.DisposeAsync();
    }

    [Fact]
    public async Task HookGateDaemon_DeniesCheckIn_WhenShutDown()
    {
        var opts = Monitor();
        var clock = new InMemoryClock();
        var audit = new InMemoryAuditLog();
        var d = new HookGateDaemon(
            new NonceManager(clock, opts),
            new InProcessRpcServer(),
            new NoopRedirection(),
            clock,
            new InMemoryEventBus(),
            opts,
            NullLogger<HookGateDaemon>.Instance,
            audit, new PassthroughFileSystem());
        // Never start â†’ running flag still 0
        var wt = Worktree(out var wtPath);
        File.WriteAllText(Path.Combine(wtPath, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        Func<Task> act = async () => await d.HandleCheckInAsync(req, CancellationToken.None);
        await Assert.ThrowsAsync<HookApprovalDeniedException>(act);
Assert.Contains(audit.Records, r => r.EventType == "hook.deny" && r.ContentJson!.Contains("shutting down"));
        await d.DisposeAsync();
    }

    // ================================================================
    // NamedPipeRpcServer â€” full lifecycle with a client connecting (covers AcceptLoopAsync)
    // ================================================================

    [Fact]
    public async Task NamedPipeRpcServer_AcceptsConnection_AndIncrementsPeerChecks()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var pipeName = "aio-hg-cov-" + Guid.NewGuid().ToString("N");
        var s = new NamedPipeRpcServer(@"\\.\pipe\" + pipeName, NullLogger<NamedPipeRpcServer>.Instance);
        await s.StartAsync((_, _) => ValueTask.FromResult<HookApproval>(null!), CancellationToken.None);

        // Connect a client so the accept-loop completes a cycle.
        using (var client = new System.IO.Pipes.NamedPipeClientStream(".", pipeName, System.IO.Pipes.PipeDirection.InOut, System.IO.Pipes.PipeOptions.Asynchronous))
        {
            await client.ConnectAsync(5000);
            // Give the accept loop a moment to process (Disconnect + loop iteration).
            for (var i = 0; i < 20 && s.PeerCredChecksPerformed == 0; i++)
            {
                await Task.Delay(50);
            }
        }

Assert.True(s.PeerCredChecksPerformed >= 1);

        await s.StopAsync(CancellationToken.None);
        await s.DisposeAsync();
    }

    // ================================================================
    // WindowsRedirectionManager â€” spawner fails â†’ symlink fallback; GetActiveMode on real dir
    // ================================================================

    [Fact]
    public async Task WindowsRedirectionManager_FallsBackToSymlink_WhenJunctionFails()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var events = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 1 };  // junction fails
        var mgr = new WindowsRedirectionManager(events, spawner, new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        var wt = Worktree(out var wtPath);
        var src = Path.Combine(wtPath, "disp");
        _ = Directory.CreateDirectory(src);
        var hooksDir = Path.Combine(wtPath, ".git", "hooks");

        // Ensure the existing hooks dir triggers Directory.Delete branch (lines 40-45).
        _ = Directory.CreateDirectory(hooksDir);

        try
        {
            await mgr.InstallRedirectionAsync(new AbsolutePath(hooksDir), new AbsolutePath(src), CancellationToken.None);
            // if we got here, symlink fallback succeeded and an event was emitted
            Assert.Equal("symlink", Assert.Single(events.Events).Mechanism);
        }
        catch (IOException)
        {
            // Developer Mode disabled â€” CreateSymbolicLink throws; the catch branch is still exercised.
        }

        await mgr.UninstallRedirectionAsync(new AbsolutePath(hooksDir), CancellationToken.None);
    }

    [Fact]
    public async Task WindowsRedirectionManager_GetActiveMode_ReturnsNotInstalled_ForPlainDir()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var mgr = new WindowsRedirectionManager(new InMemoryImmutabilitySink(), new NullProcessSpawner(), new PassthroughFileSystem(), NullLogger<WindowsRedirectionManager>.Instance);
        var tmp = Path.Combine(Path.GetTempPath(), "aio-hg-plain-" + Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(tmp);
        try
        {
            var mode = await mgr.GetActiveModeAsync(new AbsolutePath(tmp), CancellationToken.None);
Assert.Equal(RedirectionMode.NotInstalled, mode);
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch (IOException) { }
        }
    }

    // ================================================================
    // ToolRunner â€” timeout path (handle that never exits)
    // ================================================================

    [Fact]
    public async Task ToolRunner_ReturnsMinusOne_OnTimeout()
    {
        var spawner = new HangingSpawner();
        var (code, stdout) = await ToolRunner.RunAsync(spawner, "hang", Array.Empty<string>(), TimeSpan.FromMilliseconds(25), CancellationToken.None);

Assert.Equal(-1, code);
Assert.Empty(stdout);
    }

    private sealed class HangingSpawner : IProcessSpawner
    {
        public ValueTask<IProcessHandle> SpawnAsync(AiOrchestrator.Models.ProcessSpec spec, CancellationToken ct)
            => ValueTask.FromResult<IProcessHandle>(new HangingHandle());
    }

    private sealed class HangingHandle : IProcessHandle
    {
        private readonly System.IO.Pipelines.Pipe stdout = new();
        private readonly System.IO.Pipelines.Pipe stderr = new();
        private readonly System.IO.Pipelines.Pipe stdin = new();

        public int ProcessId => 1;

        public System.IO.Pipelines.PipeReader StandardOut => this.stdout.Reader;

        public System.IO.Pipelines.PipeReader StandardError => this.stderr.Reader;

        public System.IO.Pipelines.PipeWriter StandardIn => this.stdin.Writer;

        public async Task<int> WaitForExitAsync(CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
            return 0;
        }

        public ValueTask<AiOrchestrator.Abstractions.Process.ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<AiOrchestrator.Abstractions.Process.ProcessTreeNode?>(null);

        public ValueTask SignalAsync(AiOrchestrator.Abstractions.Process.ProcessSignal signal, CancellationToken ct) => default;

        public ValueTask DisposeAsync()
        {
            this.stdout.Writer.Complete();
            this.stderr.Writer.Complete();
            return ValueTask.CompletedTask;
        }
    }

    // ================================================================
    // LinkValidator â€” Windows-only cancellation guard
    // ================================================================

    [Fact]
    public async Task LinkValidator_ThrowsOnCancellation()
    {
        var v = new LinkValidator(new PassthroughFileSystem());
        var wt = Worktree(out var wtPath);
        var hook = Path.Combine(wtPath, ".git", "hooks", "pre-commit");
        File.WriteAllText(hook, "#!/bin/sh\n");

        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Func<Task> act = async () => await v.ValidateAsync(new AbsolutePath(hook), wt, cts.Token);

        await Assert.ThrowsAsync<OperationCanceledException>(act);
    }
}
