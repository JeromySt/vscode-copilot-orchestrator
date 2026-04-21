// <copyright file="HookGateContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.InteropServices;
using AiOrchestrator.HookGate.Exceptions;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.HookGate.Nonce;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Rpc;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.TestKit.Time;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.HookGate.Tests;

/// <summary>Acceptance contract tests for <see cref="HookGateDaemon"/> and subsystems (job 020).</summary>
public sealed class HookGateContractTests
{
    private const string LinuxHookGateTmpRoot = "/tmp/ai-orchestrator-hookgate-tests";

    private static HookGateOptions DefaultOptions() => new()
    {
        NonceRotation = TimeSpan.FromMinutes(5),
        ApprovalTokenTtl = TimeSpan.FromMinutes(2),
    };

    private static AbsolutePath MakeWorktree()
    {
        var root = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            "ai-orchestrator-hookgate-" + Guid.NewGuid().ToString("N"));
        _ = System.IO.Directory.CreateDirectory(root);
        _ = System.IO.Directory.CreateDirectory(System.IO.Path.Combine(root, ".git", "hooks"));
        return new AbsolutePath(root);
    }

    private static AbsolutePath WriteHookFile(AbsolutePath worktree, string name)
    {
        var dir = System.IO.Path.Combine(worktree.Value, ".git", "hooks");
        _ = System.IO.Directory.CreateDirectory(dir);
        var p = System.IO.Path.Combine(dir, name);
        System.IO.File.WriteAllText(p, "#!/bin/sh\nexit 0\n");
        return new AbsolutePath(p);
    }

    private sealed class StubRedirectionManager : IRedirectionManager
    {
        public ValueTask InstallRedirectionAsync(AbsolutePath gitHooksDir, AbsolutePath canonicalDispatcherPath, CancellationToken ct)
            => ValueTask.CompletedTask;

        public ValueTask UninstallRedirectionAsync(AbsolutePath gitHooksDir, CancellationToken ct)
            => ValueTask.CompletedTask;

        public ValueTask<RedirectionMode> GetActiveModeAsync(AbsolutePath gitHooksDir, CancellationToken ct)
            => ValueTask.FromResult(RedirectionMode.BindMount);
    }

    private static (HookGateDaemon Daemon, InProcessRpcServer Rpc, InMemoryAuditLog Audit, InMemoryEventBus Bus, InMemoryClock Clock, NonceManager Nonces)
        BuildDaemon(HookGateOptions? options = null)
    {
        var opts = new StaticOptionsMonitor<HookGateOptions>(options ?? DefaultOptions());
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var nonces = new NonceManager(clock, opts);
        var rpc = new InProcessRpcServer();
        var redirect = new StubRedirectionManager();
        var bus = new InMemoryEventBus();
        var audit = new InMemoryAuditLog();
        var daemon = new HookGateDaemon(
            nonces,
            rpc,
            redirect,
            clock,
            bus,
            opts,
            NullLogger<HookGateDaemon>.Instance,
            audit);
        return (daemon, rpc, audit, bus, clock, nonces);
    }

    // --------- HK-GATE-LINK-1 --------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-LINK-1")]
    public async Task HK_GATE_LINK_1_BindMountIsPrimaryOnLinux()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0 };
        var mgr = new LinuxRedirectionManager(sink, spawner, NullLogger<LinuxRedirectionManager>.Instance);
        var wt = MakeWorktree();
        var target = new AbsolutePath(System.IO.Path.Combine(wt.Value, "dispatcher"));
        _ = System.IO.Directory.CreateDirectory(target.Value);

        await mgr.InstallRedirectionAsync(
            new AbsolutePath(System.IO.Path.Combine(wt.Value, ".git", "hooks")),
            target,
            CancellationToken.None);

        _ = spawner.SpawnedSpecs.Should().NotBeEmpty();
        _ = spawner.SpawnedSpecs[0].Executable.Should().Be("mount");
        _ = spawner.SpawnedSpecs[0].Arguments.Should().Contain("--bind");
    }

    [Fact]
    [ContractTest("HK-GATE-LINK-1-WIN")]
    public async Task HK_GATE_LINK_1_JunctionIsPrimaryOnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var sink = new InMemoryImmutabilitySink();
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 0 };
        var mgr = new WindowsRedirectionManager(sink, spawner, NullLogger<WindowsRedirectionManager>.Instance);
        var wt = MakeWorktree();
        var target = new AbsolutePath(System.IO.Path.Combine(wt.Value, "dispatcher"));
        _ = System.IO.Directory.CreateDirectory(target.Value);

        await mgr.InstallRedirectionAsync(
            new AbsolutePath(System.IO.Path.Combine(wt.Value, ".git", "hooks")),
            target,
            CancellationToken.None);

        _ = spawner.SpawnedSpecs.Should().NotBeEmpty();
        _ = spawner.SpawnedSpecs[0].Executable.Should().Be("cmd.exe");
        _ = spawner.SpawnedSpecs[0].Arguments.Should().Contain("/J");
    }

    // --------- HK-GATE-LINK-2 --------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-LINK-2")]
    public async Task HK_GATE_LINK_2_ImmutabilityNoopEmitsWarningEvent()
    {
        var spawner = new NullProcessSpawner { ExitCodeForNextSpawn = 1 };  // all tools "fail"
        var clock = new InMemoryClock(DateTimeOffset.UtcNow);
        var probe = new ImmutabilityProbe(clock, spawner);

        var result = await probe.ProbeAsync(new AbsolutePath(System.IO.Path.GetTempPath()), CancellationToken.None);

        _ = result.Supported.Should().BeFalse();
        _ = probe.IsImmutabilitySupported(result).Should().BeFalse();
        var evt = probe.BuildEvent(new AbsolutePath(System.IO.Path.GetTempPath()), result);
        _ = evt.Mechanism.Should().NotBeNullOrEmpty();
        _ = evt.Reason.Should().NotBeNullOrEmpty();
    }

    // --------- HK-GATE-LINK-3 --------------------------------------------

    [DllImport("libc", SetLastError = true, EntryPoint = "link")]
    private static extern int LibcLink(string oldpath, string newpath);

    [Fact]
    [ContractTest("HK-GATE-LINK-3")]
    public async Task HK_GATE_LINK_3_HardlinkTamperRejected()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        var wt = MakeWorktree();
        var hook = WriteHookFile(wt, "pre-commit");
        var link = hook.Value + ".link";
        _ = LibcLink(hook.Value, link);

        var (daemon, _, audit, _, _, _) = BuildDaemon();
        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        var act = async () => await daemon.HandleCheckInAsync(req, CancellationToken.None);
        _ = await act.Should().ThrowAsync<HookApprovalDeniedException>();
        _ = audit.Records.Should().Contain(r => r.EventType == "hook.deny");
    }

    [Fact]
    [ContractTest("HK-GATE-LINK-3-WIN")]
    public async Task HK_GATE_LINK_3_ReparsePointTamperRejected()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var wt = MakeWorktree();
        var outside = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ai-outside-" + Guid.NewGuid().ToString("N"));
        _ = System.IO.Directory.CreateDirectory(outside);
        var realFile = System.IO.Path.Combine(outside, "evil.sh");
        System.IO.File.WriteAllText(realFile, "#!/bin/sh\nexit 1\n");
        var hookPath = System.IO.Path.Combine(wt.Value, ".git", "hooks", "pre-commit");
        _ = System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(hookPath)!);
        try
        {
            System.IO.File.CreateSymbolicLink(hookPath, realFile);
        }
        catch (System.IO.IOException)
        {
            return;  // symlink creation requires Developer Mode; skip when unavailable
        }
        catch (UnauthorizedAccessException)
        {
            return;
        }

        var (daemon, _, audit, _, _, _) = BuildDaemon();
        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(@".git\hooks\pre-commit"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        var act = async () => await daemon.HandleCheckInAsync(req, CancellationToken.None);
        _ = await act.Should().ThrowAsync<HookApprovalDeniedException>();
        _ = audit.Records.Should().Contain(r => r.EventType == "hook.deny");
    }

    // --------- HK-GATE-NONCE ---------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-NONCE-ROT")]
    public void HK_GATE_NONCE_RotatesEvery5Min()
    {
        var opts = new StaticOptionsMonitor<HookGateOptions>(DefaultOptions());
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var mgr = new NonceManager(clock, opts);
        var first = mgr.Current;

        clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        var second = mgr.Current;

        _ = second.Value.Should().NotBe(first.Value);
    }

    [Fact]
    [ContractTest("HK-GATE-NONCE-OVERLAP")]
    public void HK_GATE_NONCE_OverlapAcceptsOldNonceForOneCycle()
    {
        var opts = new StaticOptionsMonitor<HookGateOptions>(DefaultOptions());
        var clock = new InMemoryClock(DateTimeOffset.Parse("2030-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var mgr = new NonceManager(clock, opts);
        var original = mgr.Current;

        clock.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
        _ = mgr.Current;

        _ = mgr.Previous.Should().NotBeNull();
        _ = mgr.Previous!.Value.Should().Be(original.Value);
    }

    // --------- HK-GATE-HMAC ----------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-HMAC")]
    public void HK_GATE_HMAC_DeterministicForCanonicalForm()
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
            WorktreeRoot = new AbsolutePath(System.IO.Path.GetTempPath()),
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary.CreateRange(new[]
            {
                new KeyValuePair<string, string>("A", "1"),
                new KeyValuePair<string, string>("B", "2"),
            }),
        };

        var h1 = ApprovalIssuer.ComputeHmac(nonce, req);
        var h2 = ApprovalIssuer.ComputeHmac(nonce, req);
        _ = h1.Should().BeEquivalentTo(h2);
    }

    // --------- HK-GATE-DENY ----------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-DENY")]
    public async Task HK_GATE_DENIED_AuditedAndExceptionThrown()
    {
        var (daemon, _, audit, _, _, _) = BuildDaemon();
        var wt = MakeWorktree();
        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/does-not-exist"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        var act = async () => await daemon.HandleCheckInAsync(req, CancellationToken.None);
        _ = await act.Should().ThrowAsync<HookApprovalDeniedException>();
        _ = audit.Records.Should().Contain(r => r.EventType == "hook.deny");
    }

    // --------- HK-GATE-IPC -----------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-IPC")]
    public async Task HK_GATE_IPC_PeerCredsCheckedPerMessage()
    {
        var (daemon, rpc, _, _, _, _) = BuildDaemon();
        var wt = MakeWorktree();
        var hook = WriteHookFile(wt, "pre-commit");
        await daemon.StartAsync(CancellationToken.None);

        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        _ = await rpc.DispatchAsync(req, CancellationToken.None);
        _ = await rpc.DispatchAsync(req, CancellationToken.None);
        _ = await rpc.DispatchAsync(req, CancellationToken.None);

        _ = rpc.PeerCredChecksPerformed.Should().Be(3);
        _ = daemon.PeerCredChecksPerformed.Should().Be(3);

        await daemon.StopAsync(CancellationToken.None);
    }

    // --------- HK-GATE-PERMS ---------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-PERMS")]
    public async Task HK_GATE_REFUSE_StartIfSocketDirPermsBroad()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
            && !RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return;
        }

        _ = System.IO.Directory.CreateDirectory(LinuxHookGateTmpRoot);
        var broadDir = System.IO.Path.Combine(LinuxHookGateTmpRoot, "broad-" + Guid.NewGuid().ToString("N"));
        _ = System.IO.Directory.CreateDirectory(broadDir);
        try
        {
            System.IO.File.SetUnixFileMode(broadDir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }
        catch (PlatformNotSupportedException)
        {
            return;
        }

        var options = DefaultOptions() with { SocketPath = new AbsolutePath(System.IO.Path.Combine(broadDir, "hg.sock")) };
        var (daemon, _, _, _, _, _) = BuildDaemon(options);

        var act = async () => await daemon.StartAsync(CancellationToken.None);
        _ = await act.Should().ThrowAsync<InvalidOperationException>();
    }

    // --------- HK-GATE-SHUTDOWN ------------------------------------------

    [Fact]
    [ContractTest("HK-GATE-SHUTDOWN")]
    public async Task HK_GATE_GRACEFUL_ShutdownDrainsInFlight()
    {
        var (daemon, rpc, _, _, _, _) = BuildDaemon();
        var wt = MakeWorktree();
        var hook = WriteHookFile(wt, "pre-commit");
        await daemon.StartAsync(CancellationToken.None);

        var req = new HookCheckInRequest
        {
            Kind = HookKind.PreCommit,
            HookFile = new RepoRelativePath(".git/hooks/pre-commit"),
            WorktreeRoot = wt,
            Principal = TestPrincipals.Alice(),
            Env = ImmutableDictionary<string, string>.Empty,
        };

        var approval = await rpc.DispatchAsync(req, CancellationToken.None);
        _ = approval.Should().NotBeNull();

        await daemon.StopAsync(CancellationToken.None);

        // After shutdown, new check-ins are rejected with "daemon shutting down".
        var act = async () => await daemon.HandleCheckInAsync(req, CancellationToken.None);
        var ex = (await act.Should().ThrowAsync<HookApprovalDeniedException>()).Which;
        _ = ex.Reason.Should().Be("daemon shutting down");
    }
}
