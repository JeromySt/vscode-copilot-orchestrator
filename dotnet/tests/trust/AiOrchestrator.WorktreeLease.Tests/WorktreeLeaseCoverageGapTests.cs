// <copyright file="WorktreeLeaseCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Text.Json;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.WorktreeLease.Detection;
using AiOrchestrator.WorktreeLease.Events;
using AiOrchestrator.WorktreeLease.Exceptions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.WorktreeLease.Tests;

/// <summary>Tests targeting uncovered branches in WorktreeLease subsystems.</summary>
public sealed class WorktreeLeaseCoverageGapTests
{
    // ================================================================
    // FencingToken — comparison operators, CompareTo, ToString (0%)
    // ================================================================

    [Fact]
    public void FencingToken_LessThan_ReturnsTrue_WhenSmaller()
    {
        var a = new FencingToken(1);
        var b = new FencingToken(2);
        Assert.True(a < b);
        Assert.False(b < a);
    }

    [Fact]
    public void FencingToken_GreaterThan_ReturnsTrue_WhenLarger()
    {
        var a = new FencingToken(5);
        var b = new FencingToken(3);
        Assert.True(a > b);
        Assert.False(b > a);
    }

    [Fact]
    public void FencingToken_LessThanOrEqual_HandlesEquality()
    {
        var a = new FencingToken(3);
        var b = new FencingToken(3);
        var c = new FencingToken(4);
        Assert.True(a <= b);
        Assert.True(a <= c);
        Assert.False(c <= a);
    }

    [Fact]
    public void FencingToken_GreaterThanOrEqual_HandlesEquality()
    {
        var a = new FencingToken(3);
        var b = new FencingToken(3);
        var c = new FencingToken(2);
        Assert.True(a >= b);
        Assert.True(a >= c);
        Assert.False(c >= a);
    }

    [Fact]
    public void FencingToken_CompareTo_ReturnsCorrectOrdering()
    {
        var low = new FencingToken(1);
        var mid = new FencingToken(5);
        var high = new FencingToken(10);

        Assert.True(low.CompareTo(mid) < 0);
        Assert.True(high.CompareTo(mid) > 0);
        Assert.Equal(0, mid.CompareTo(new FencingToken(5)));
    }

    [Fact]
    public void FencingToken_ToString_ReturnsInvariantString()
    {
        var token = new FencingToken(42);
        Assert.Equal("42", token.ToString());
    }

    [Fact]
    public void FencingToken_Equality_WorksCorrectly()
    {
        var a = new FencingToken(7);
        var b = new FencingToken(7);
        var c = new FencingToken(8);

        Assert.Equal(a, b);
        Assert.NotEqual(a, c);
        Assert.True(a == b);
        Assert.True(a != c);
    }

    // ================================================================
    // LeaseHandle — no callback, MarkDisposed, DisposeAsync idempotent
    // ================================================================

    [Fact]
    public async Task LeaseHandle_WithoutCallback_DisposeAsync_DoesNotThrow()
    {
        var handle = new LeaseHandle
        {
            Token = new FencingToken(1),
            Worktree = new AbsolutePath(Path.GetTempPath()),
            Holder = Mocks.TestPrincipal,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        await handle.DisposeAsync();
        Assert.True(handle.IsDisposed);
    }

    [Fact]
    public async Task LeaseHandle_DisposeAsync_IsIdempotent()
    {
        var callCount = 0;
        var handle = new LeaseHandle((_, _) =>
        {
            callCount++;
            return ValueTask.CompletedTask;
        })
        {
            Token = new FencingToken(1),
            Worktree = new AbsolutePath(Path.GetTempPath()),
            Holder = Mocks.TestPrincipal,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        await handle.DisposeAsync();
        await handle.DisposeAsync(); // second call is a no-op
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void LeaseHandle_MarkDisposed_SetsIsDisposed()
    {
        var handle = new LeaseHandle
        {
            Token = new FencingToken(1),
            Worktree = new AbsolutePath(Path.GetTempPath()),
            Holder = Mocks.TestPrincipal,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        Assert.False(handle.IsDisposed);
        handle.MarkDisposed();
        Assert.True(handle.IsDisposed);
    }

    // ================================================================
    // WorktreeLeaseManager — InspectAsync, RenewAsync stale token
    // ================================================================

    [Fact]
    public async Task WorktreeLeaseManager_InspectAsync_NoLeaseFile_ReturnsNull()
    {
        using var temp = new TempDir();
        var mgr = MakeManager();
        var result = await mgr.InspectAsync(new AbsolutePath(temp.Path), default);
        Assert.Null(result);
    }

    [Fact]
    public async Task WorktreeLeaseManager_InspectAsync_WithLease_ReturnsLeaseInfo()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();

        await using var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);
        var info = await mgr.InspectAsync(worktree, default);

        Assert.NotNull(info);
        Assert.Equal(handle.Token, info!.Token);
        Assert.Equal(Mocks.TestPrincipal.DisplayName, info.Holder.DisplayName);
    }

    [Fact]
    public async Task WorktreeLeaseManager_RenewAsync_NullHandle_Throws()
    {
        var mgr = MakeManager();
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => mgr.RenewAsync(null!, TimeSpan.FromMinutes(1), default).AsTask());
    }

    [Fact]
    public async Task WorktreeLeaseManager_RenewAsync_StaleToken_ThrowsStaleLeaseTokenException()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();

        await using var handle1 = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

        // Create a second handle with a stale token by manipulating the lease file
        var staleHandle = new LeaseHandle
        {
            Token = new FencingToken(999), // doesn't match stored token
            Worktree = worktree,
            Holder = Mocks.TestPrincipal,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        await Assert.ThrowsAsync<StaleLeaseTokenException>(
            () => mgr.RenewAsync(staleHandle, TimeSpan.FromMinutes(5), default).AsTask());
    }

    [Fact]
    public async Task WorktreeLeaseManager_RenewAsync_NoLeaseFile_ThrowsStaleLeaseTokenException()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();

        var handle = new LeaseHandle
        {
            Token = new FencingToken(1),
            Worktree = worktree,
            Holder = Mocks.TestPrincipal,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        await Assert.ThrowsAsync<StaleLeaseTokenException>(
            () => mgr.RenewAsync(handle, TimeSpan.FromMinutes(5), default).AsTask());
    }

    [Fact]
    public async Task WorktreeLeaseManager_AcquireAsync_NullHolder_Throws()
    {
        using var temp = new TempDir();
        var mgr = MakeManager();
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => mgr.AcquireAsync(new AbsolutePath(temp.Path), null!, TimeSpan.FromMinutes(1), default).AsTask());
    }

    [Fact]
    public async Task WorktreeLeaseManager_ReleaseAsync_NullHandle_Throws()
    {
        var mgr = MakeManager();
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => mgr.ReleaseAsync(null!, default).AsTask());
    }

    [Fact]
    public async Task WorktreeLeaseManager_AcquireAsync_ExpiredLease_Succeeds()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var clock = new TestClock { Now = DateTimeOffset.UtcNow };
        var mgr = MakeManager(clock: clock);

        // Acquire a short-lived lease
        await using var handle1 = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMilliseconds(1), default);
        await handle1.DisposeAsync();

        // Advance past expiry
        clock.Now = DateTimeOffset.UtcNow.AddMinutes(5);

        // Re-write the lease file to simulate an expired-but-present lease
        var leaseDir = Path.Combine(temp.Path, ".aio");
        Directory.CreateDirectory(leaseDir);
        var leaseFile = Path.Combine(leaseDir, "lease.json");
        await File.WriteAllTextAsync(leaseFile, JsonSerializer.Serialize(new
        {
            token = 1L,
            holderUserName = "old",
            holderProcessHash = "hash",
            acquiredAt = DateTimeOffset.UtcNow.AddMinutes(-10),
            expiresAt = DateTimeOffset.UtcNow.AddMinutes(-5),
            schemaVersion = "1",
        }));

        // Acquire again — should succeed because the existing lease is expired
        await using var handle2 = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);
        Assert.True(handle2.Token.Value >= 2);
    }

    // ================================================================
    // StaleLeaseDetector — idempotent dispose, IO exception resilience
    // ================================================================

    [Fact]
    public async Task StaleLeaseDetector_DisposeAsync_IsIdempotent()
    {
        var bus = new CapturingEventBus();
        var opts = new LeaseOptions { StaleCheckInterval = TimeSpan.FromMinutes(5) };
        await using var detector = new StaleLeaseDetector(
            new StubFileSystem(),
            new TestClock { Now = DateTimeOffset.UtcNow },
            bus,
            Mocks.Opts(opts));

        await detector.DisposeAsync();
        await detector.DisposeAsync(); // second dispose is a no-op
    }

    [Fact]
    public async Task StaleLeaseDetector_NoLeaseFile_ContinuesPolling()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var bus = new CapturingEventBus();
        var opts = new LeaseOptions { StaleCheckInterval = TimeSpan.FromMilliseconds(20) };
        await using var detector = new StaleLeaseDetector(
            new StubFileSystem(),
            new TestClock { Now = DateTimeOffset.UtcNow },
            bus,
            Mocks.Opts(opts));

        await detector.StartAsync(worktree, new FencingToken(1), default);
        await Task.Delay(100);
        // No events should be published when no lease file exists
        Assert.Empty(bus.Events.OfType<WorktreeLeaseStolen>());
    }

    // ================================================================
    // WorktreeLeaseManager — ReleaseAsync explicit
    // ================================================================

    [Fact]
    public async Task WorktreeLeaseManager_ReleaseAsync_SetsHandleDisposed()
    {
        using var temp = new TempDir();
        var worktree = new AbsolutePath(temp.Path);
        var mgr = MakeManager();
        var handle = await mgr.AcquireAsync(worktree, Mocks.TestPrincipal, TimeSpan.FromMinutes(1), default);

        Assert.False(handle.IsDisposed);
        await mgr.ReleaseAsync(handle, default);
        Assert.True(handle.IsDisposed);
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static WorktreeLeaseManager MakeManager(
        TestClock? clock = null,
        CapturingEventBus? bus = null,
        LeaseOptions? options = null)
    {
        return new WorktreeLeaseManager(
            new StubFileSystem(),
            clock ?? new TestClock(),
            bus ?? new CapturingEventBus(),
            Mocks.Opts(options),
            NullLogger<WorktreeLeaseManager>.Instance);
    }
}
