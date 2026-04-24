// <copyright file="WorktreeLeaseManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

#pragma warning disable CA1303 // Do not pass literals as localized parameters.

using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.WorktreeLease.Cas;
using AiOrchestrator.WorktreeLease.Exceptions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.WorktreeLease;

/// <summary>
/// Production <see cref="IWorktreeLease"/> that implements CAS-under-lock acquisition
/// (LS-CAS-1), bounded retry (LS-CAS-2), strictly-monotonic fencing tokens (LS-CAS-3),
/// and stale-write rejection (LS-INF-1).
/// </summary>
public sealed class WorktreeLeaseManager : IWorktreeLease
{
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<LeaseOptions> opts;
    private readonly ILogger<WorktreeLeaseManager> logger;
    private readonly CasLeaseStore store;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, long> highWater = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Initializes a new instance of the <see cref="WorktreeLeaseManager"/> class.</summary>
    /// <param name="fs">File system abstraction.</param>
    /// <param name="clock">Clock used for <c>AcquiredAt</c>/<c>ExpiresAt</c>.</param>
    /// <param name="bus">Event bus used by companion <c>StaleLeaseDetector</c>.</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="logger">Logger.</param>
    public WorktreeLeaseManager(
        IFileSystem fs,
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<LeaseOptions> opts,
        ILogger<WorktreeLeaseManager> logger)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
        this.store = new CasLeaseStore(fs, clock);
    }

    /// <summary>Gets the underlying CAS store (exposed for integration with worktree-write enforcement).</summary>
    internal CasLeaseStore Store => this.store;

    /// <inheritdoc/>
    public async ValueTask<LeaseHandle> AcquireAsync(
        AbsolutePath worktree,
        AuthContext holder,
        TimeSpan ttl,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(holder);
        ct.ThrowIfCancellationRequested();

        var leaseFile = CasLeaseStore.LeaseFileFor(worktree);
        var current = this.opts.CurrentValue;
        var deadline = this.clock.MonotonicMilliseconds + (long)current.AcquireTimeout.TotalMilliseconds;
        var processHash = ComputeProcessHash();

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            // Read current stored token (if any) to know the expected prior for CAS.
            FencingToken priorToken;
            LeaseFileContent? existing = null;
            try
            {
                existing = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false);
                priorToken = existing?.Token ?? new FencingToken(0);
            }
            catch (IOException)
            {
                // transient — retry
                priorToken = new FencingToken(0);
            }
            catch (UnauthorizedAccessException)
            {
                // transient sharing violation on Windows — retry
                priorToken = new FencingToken(0);
            }

            // Mutual exclusion: if a live (un-expired) lease exists, back off and retry.
            if (existing is not null && existing.ExpiresAt > this.clock.UtcNow)
            {
                if (this.clock.MonotonicMilliseconds >= deadline)
                {
                    throw new LeaseAcquireTimeoutException(worktree, current.AcquireTimeout);
                }

                await Task.Delay(current.AcquireRetryDelay, ct).ConfigureAwait(false);
                continue;
            }

            var hw = this.highWater.GetOrAdd(worktree.Value, 0);
            var basis = Math.Max(priorToken.Value, hw);
            var nextToken = new FencingToken(basis + 1);
            var now = this.clock.UtcNow;
            var content = new LeaseFileContent
            {
                Token = nextToken,
                HolderUserName = holder.DisplayName,
                HolderProcessHash = processHash,
                AcquiredAt = now,
                ExpiresAt = now.Add(ttl),
                SchemaVersion = CasLeaseStore.SupportedSchemaVersion,
            };

            bool swapped;
            try
            {
                swapped = await this.store.TryWriteAsync(leaseFile, content, priorToken, ct).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // FileShare.None — another writer holds the lock; retry after delay.
                swapped = false;
            }
            catch (UnauthorizedAccessException)
            {
                // transient sharing violation on Windows — retry
                swapped = false;
            }

            if (swapped)
            {
                // Record the issued token as the new high-water mark so future acquires never reuse it.
                _ = this.highWater.AddOrUpdate(worktree.Value, nextToken.Value, (_, cur) => Math.Max(cur, nextToken.Value));

                this.logger.LogInformation(
                    "Acquired lease on {Worktree} with token {Token} for {Holder}.",
                    worktree.Value,
                    nextToken.Value,
                    holder.DisplayName);

                return new LeaseHandle(this.ReleaseCoreAsync)
                {
                    Token = nextToken,
                    Worktree = worktree,
                    Holder = holder,
                    ExpiresAt = content.ExpiresAt,
                };
            }

            if (this.clock.MonotonicMilliseconds >= deadline)
            {
                throw new LeaseAcquireTimeoutException(worktree, current.AcquireTimeout);
            }

            try
            {
                await Task.Delay(current.AcquireRetryDelay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
        }
    }

    /// <inheritdoc/>
    public async ValueTask RenewAsync(LeaseHandle handle, TimeSpan ttl, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(handle);
        ct.ThrowIfCancellationRequested();

        var leaseFile = CasLeaseStore.LeaseFileFor(handle.Worktree);
        var existing = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false)
            ?? throw new StaleLeaseTokenException
            {
                ProvidedToken = handle.Token,
                StoredToken = new FencingToken(0),
            };

        if (existing.Token.Value != handle.Token.Value)
        {
            throw new StaleLeaseTokenException
            {
                ProvidedToken = handle.Token,
                StoredToken = existing.Token,
            };
        }

        var hw = this.highWater.GetOrAdd(handle.Worktree.Value, 0);
        var basis = Math.Max(existing.Token.Value, hw);
        var nextToken = new FencingToken(basis + 1);
        var now = this.clock.UtcNow;
        var content = new LeaseFileContent
        {
            Token = nextToken,
            HolderUserName = handle.Holder.DisplayName,
            HolderProcessHash = existing.HolderProcessHash,
            AcquiredAt = existing.AcquiredAt,
            ExpiresAt = now.Add(ttl),
            SchemaVersion = CasLeaseStore.SupportedSchemaVersion,
        };

        var swapped = await this.store.TryWriteAsync(leaseFile, content, existing.Token, ct).ConfigureAwait(false);
        if (!swapped)
        {
            var fresh = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false);
            throw new StaleLeaseTokenException
            {
                ProvidedToken = handle.Token,
                StoredToken = fresh?.Token ?? new FencingToken(0),
            };
        }

        _ = this.highWater.AddOrUpdate(handle.Worktree.Value, nextToken.Value, (_, cur) => Math.Max(cur, nextToken.Value));

        // Mutate handle in place — callers hold the same reference.
        HandleAccess.Update(handle, nextToken, content.ExpiresAt);
    }

    /// <inheritdoc/>
    public async ValueTask ReleaseAsync(LeaseHandle handle, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(handle);
        await this.ReleaseCoreAsync(handle, ct).ConfigureAwait(false);
        handle.MarkDisposed();
    }

    /// <inheritdoc/>
    public async ValueTask<LeaseInfo?> InspectAsync(AbsolutePath worktree, CancellationToken ct)
    {
        var leaseFile = CasLeaseStore.LeaseFileFor(worktree);
        var content = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false);
        if (content is null)
        {
            return null;
        }

        return new LeaseInfo
        {
            Token = content.Token,
            Holder = new AuthContext
            {
                PrincipalId = content.HolderUserName,
                DisplayName = content.HolderUserName,
                Scopes = System.Collections.Immutable.ImmutableArray<string>.Empty,
            },
            ExpiresAt = content.ExpiresAt,
            AcquiredAt = content.AcquiredAt,
        };
    }

    private static string ComputeProcessHash()
    {
        var raw = $"{Environment.MachineName}:{Environment.ProcessId}:{ProcessStartupNonce}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(bytes)[..16];
    }

    /// <summary>
    /// A nonce generated once per process lifetime, used as a substitute for
    /// <c>Process.GetCurrentProcess().StartTime</c> to avoid a dependency on
    /// <c>System.Diagnostics.Process</c>.
    /// </summary>
    private static readonly string ProcessStartupNonce = Guid.NewGuid().ToString("N");

    private async ValueTask ReleaseCoreAsync(LeaseHandle handle, CancellationToken ct)
    {
        var leaseFile = CasLeaseStore.LeaseFileFor(handle.Worktree);
        try
        {
            var existing = await this.store.ReadAsync(leaseFile, ct).ConfigureAwait(false);
            if (existing is not null && existing.Token.Value == handle.Token.Value)
            {
                await this.store.DeleteAsync(leaseFile, ct).ConfigureAwait(false);
            }
        }
        catch (IOException ex)
        {
            this.logger.LogWarning(ex, "Lease file could not be deleted for {Worktree}.", handle.Worktree.Value);
        }
        catch (UnauthorizedAccessException ex)
        {
            this.logger.LogWarning(ex, "Lease file could not be deleted for {Worktree}.", handle.Worktree.Value);
        }
    }
}
