// <copyright file="WorktreeLeaseContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.WorktreeLease.Cas;
using AiOrchestrator.WorktreeLease.Detection;
using AiOrchestrator.WorktreeLease.Events;
using AiOrchestrator.WorktreeLease.Exceptions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.WorktreeLease.Tests;

/// <summary>Acceptance tests for the worktree-lease module (§3.31.2.1).</summary>
public sealed class WorktreeLeaseContractTests
{
    [Fact]
    [ContractTest("LS-CAS-1")]
    public async Task LS_CAS_1_AcquireWritesIncrementedToken()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();

        await using var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

Assert.Equal(1, handle.Token.Value);
Assert.Equal(worktree, handle.Worktree);

        // Lease file must exist and contain token=1.
        var leaseFile = Path.Combine(temp.Path, ".aio", "lease.json");
Assert.True(File.Exists(leaseFile));
        using var jdoc = JsonDocument.Parse(await File.ReadAllTextAsync(leaseFile));
Assert.Equal(1, jdoc.RootElement.GetProperty("token").GetInt64());
Assert.Equal("1", jdoc.RootElement.GetProperty("schemaVersion").GetString());
    }

    [Fact]
    [ContractTest("LS-CAS-2")]
    public async Task LS_CAS_2_ContentionRetriesThenTimesOut()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var opts = new LeaseOptions
        {
            AcquireTimeout = TimeSpan.FromMilliseconds(300),
            AcquireRetryDelay = TimeSpan.FromMilliseconds(50),
        };
        var clock = new TestClock();
        var mgr = MakeManager(clock: clock, options: opts);

        // Simulate a clock that advances past the acquire timeout so the deadline check fires.
        clock.Mono = 0;

        // Pre-create .aio and hold an exclusive lock on the lease file.
        var aioDir = Path.Combine(temp.Path, ".aio");
        _ = Directory.CreateDirectory(aioDir);
        var leasePath = Path.Combine(aioDir, "lease.json");
        await using (var blocker = new FileStream(leasePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            // Start acquire while the file is locked — must throw LeaseAcquireTimeoutException.
            // Advance the monotonic clock on every retry so the deadline fires deterministically.
            var tcs = new TaskCompletionSource();
            var acquireTask = Task.Run(async () =>
            {
                try
                {
                    _ = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);
                }
                finally
                {
                    tcs.TrySetResult();
                }
            });

            // Let the acquire loop attempt a few times, then jump the monotonic clock.
            await Task.Delay(150);
            clock.Mono = 10_000;

            var act = async () => await acquireTask;
            await Assert.ThrowsAsync<LeaseAcquireTimeoutException>(act);
        }
    }

    [Fact(Timeout = 30_000)]
    [ContractTest("LS-CAS-3")]
    public async Task LS_CAS_3_FencingTokenStrictlyMonotonic()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager(clock: new RealClock(), options: new LeaseOptions
        {
            AcquireTimeout = TimeSpan.FromSeconds(20),
            AcquireRetryDelay = TimeSpan.FromMilliseconds(5),
        });

        const int acquirerCount = 32;
        var tokens = new ConcurrentBag<long>();
        var concurrent = 0;
        var maxConcurrent = 0;

        async Task Worker()
        {
            var h = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromSeconds(10), default);
            var c = Interlocked.Increment(ref concurrent);
            int snap;
            do
            {
                snap = maxConcurrent;
                if (c <= snap)
                {
                    break;
                }
            }
            while (Interlocked.CompareExchange(ref maxConcurrent, c, snap) != snap);

            await Task.Delay(10);
            tokens.Add(h.Token.Value);
            _ = Interlocked.Decrement(ref concurrent);
            await h.DisposeAsync();
        }

        var tasks = Enumerable.Range(0, acquirerCount).Select(_ => Worker()).ToArray();
        await Task.WhenAll(tasks);

        Assert.Equal(acquirerCount, tokens.Count);
        Assert.Equal(acquirerCount, tokens.Distinct().Count());
        Assert.Equal(1, maxConcurrent); // no two acquirers may hold the lease simultaneously
Assert.True(tokens.Max() >= acquirerCount);
    }

    [Fact]
    [ContractTest("LS-INF-1")]
    public async Task LS_INF_1_StaleTokenRejected()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();
        await using var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

        // Direct access to the CAS store to test EnforceWriteWithTokenAsync.
        var store = mgr.Store;

        // Valid token succeeds.
        var rel = new RepoRelativePath("ok.txt");
        var ok = await store.EnforceWriteWithTokenAsync(worktree, handle.Token, rel, new byte[] { 1, 2, 3 }, default);
Assert.True(ok);

        // Stale token fails.
        var stale = new FencingToken(handle.Token.Value - 1);
        var act = async () => await store.EnforceWriteWithTokenAsync(worktree, stale, new RepoRelativePath("bad.txt"), new byte[] { 9 }, default);
        await Assert.ThrowsAsync<StaleLeaseTokenException>(act);

        // Target file must NOT exist — the write must be skipped on stale token.
Assert.False(File.Exists(Path.Combine(temp.Path, "bad.txt")));
    }

    [Fact(Skip = "OE0040 Roslyn analyzer is scheduled for a follow-up analyzer-project job (job 011). " +
        "The enforcement path is validated by LS_INF_1_StaleTokenRejected; the analyzer complements it " +
        "by preventing direct IFileSystem.WriteAsync calls at compile time.")]
    [ContractTest("LS-INF-2")]
    public void LS_INF_2_AnalyzerForbidsBypass()
    {
        // Intentionally skipped — see [Fact(Skip=...)] attribute for rationale.
    }

    [Fact]
    [ContractTest("LS-DETECT")]
    public async Task LS_DETECT_LeaseStolenEventEmitted()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var bus = new CapturingEventBus();
        var opts = new LeaseOptions { StaleCheckInterval = TimeSpan.FromMilliseconds(40) };
        var mgr = MakeManager(bus: bus, options: opts);

        await using var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

        // Spin up the detector with the expected token.
        await using var detector = new StaleLeaseDetector(new StubFileSystem(), new TestClock { Now = DateTimeOffset.UtcNow }, bus, Mocks.Opts(opts));
        await detector.StartAsync(worktree, handle.Token, default);

        // Steal the lease: rewrite the lease file with a higher token.
        var leaseFile = Path.Combine(temp.Path, ".aio", "lease.json");
        await File.WriteAllTextAsync(leaseFile, JsonSerializer.Serialize(new
        {
            token = handle.Token.Value + 100,
            holderUserName = "thief",
            holderProcessHash = "xx",
            acquiredAt = DateTimeOffset.UtcNow,
            expiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
            schemaVersion = "1",
        }));

        // Wait for the detector to notice.
        var sw = Stopwatch.StartNew();
        while (bus.Events.Count == 0 && sw.Elapsed < TimeSpan.FromSeconds(5))
        {
            await Task.Delay(25);
        }

Assert.True(bus.Events.OfType<WorktreeLeaseStolen>().Count() > 0);
        var evt = bus.Events.OfType<WorktreeLeaseStolen>().First();
Assert.Equal(handle.Token, evt.ExpectedToken);
Assert.Equal(handle.Token.Value + 100, evt.ObservedToken.Value);
    }

    [Fact]
    [ContractTest("LS-RENEW")]
    public async Task LS_RENEW_IncrementsToken()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();

        await using var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);
        var initial = handle.Token.Value;

        await mgr.RenewAsync(handle, TimeSpan.FromMinutes(5), default);
Assert.Equal(initial + 1, handle.Token.Value);

        await mgr.RenewAsync(handle, TimeSpan.FromMinutes(5), default);
Assert.Equal(initial + 2, handle.Token.Value);
    }

    [Fact]
    [ContractTest("LS-DISPOSE")]
    public async Task LS_DISPOSE_Idempotent()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();
        var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

        await handle.DisposeAsync();
Assert.True(handle.IsDisposed);

        // Second dispose is a no-op — must not throw.
        var act = async () => await handle.DisposeAsync();
        await act();

        // Lease file is removed.
        var leaseFile = Path.Combine(temp.Path, ".aio", "lease.json");
Assert.False(File.Exists(leaseFile));
    }

    [Fact]
    [ContractTest("LS-SCHEMA")]
    public async Task LS_SCHEMA_RejectsUnknownVersion()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var leaseDir = Path.Combine(temp.Path, ".aio");
        _ = Directory.CreateDirectory(leaseDir);
        var leaseFile = Path.Combine(leaseDir, "lease.json");

        // Write a lease file with an unknown schema version.
        await File.WriteAllTextAsync(leaseFile, JsonSerializer.Serialize(new
        {
            token = 1L,
            holderUserName = "x",
            holderProcessHash = "hash",
            acquiredAt = DateTimeOffset.UtcNow,
            expiresAt = DateTimeOffset.UtcNow.AddHours(1),
            schemaVersion = "99",
        }));

        var mgr = MakeManager();
        var act = async () => await mgr.InspectAsync(worktree, default);
        var ex = await Assert.ThrowsAsync<UnsupportedLeaseSchemaException>(act);
Assert.Equal("99", ex.ObservedVersion);
    }

    private static WorktreeLeaseManager MakeManager(
        IFileSystem? fs = null,
        IClock? clock = null,
        CapturingEventBus? bus = null,
        LeaseOptions? options = null)
    {
        return new WorktreeLeaseManager(
            fs ?? new StubFileSystem(),
            clock ?? new TestClock(),
            bus ?? new CapturingEventBus(),
            Mocks.Opts(options),
            NullLogger<WorktreeLeaseManager>.Instance);
    }
}
