// <copyright file="UpdateController.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Audit.Trust;
using AiOrchestrator.Daemon.PidFile;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Daemon.Update;

/// <summary>
/// Long-running update poller. Implements UPD-RB-1..7. NEVER signs anything (TRUST-ROOT-4).
/// </summary>
public sealed class UpdateController : BackgroundService
{
    private static readonly AuthContext SystemPrincipal = new()
    {
        PrincipalId = "system:daemon",
        DisplayName = "Daemon",
        Scopes = ImmutableArray.Create("daemon.update"),
        IssuedAtUtc = DateTimeOffset.UnixEpoch,
    };

    private readonly IHttpClientFactory http;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly IAuditLog audit;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<DaemonOptions> opts;
    private readonly ILogger<UpdateController> logger;
    private readonly ReleaseManifestFetcher fetcher;
    private readonly StagedSwap swap;
    private readonly HealthCheck health;

    private HashSet<string>? lastObservedKeys;

    /// <summary>Initializes a new instance of the <see cref="UpdateController"/> class.</summary>
    /// <param name="http">HTTP client factory.</param>
    /// <param name="fs">Filesystem abstraction.</param>
    /// <param name="clock">Clock abstraction.</param>
    /// <param name="audit">Audit log.</param>
    /// <param name="bus">Event bus.</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="logger">Logger.</param>
    /// <param name="fetcher">Manifest fetcher.</param>
    /// <param name="swap">Staged-swap helper.</param>
    /// <param name="health">Post-swap health check.</param>
    internal UpdateController(
        IHttpClientFactory http,
        IFileSystem fs,
        IClock clock,
        IAuditLog audit,
        IEventBus bus,
        IOptionsMonitor<DaemonOptions> opts,
        ILogger<UpdateController> logger,
        ReleaseManifestFetcher fetcher,
        StagedSwap swap,
        HealthCheck health)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(fs);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(audit);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(fetcher);
        ArgumentNullException.ThrowIfNull(swap);
        ArgumentNullException.ThrowIfNull(health);
        this.http = http;
        this.fs = fs;
        this.clock = clock;
        this.audit = audit;
        this.bus = bus;
        this.opts = opts;
        this.logger = logger;
        this.fetcher = fetcher;
        this.swap = swap;
        this.health = health;
    }

    /// <summary>Gets the number of times <see cref="CheckAndApplyAsync"/> has been called (test telemetry).</summary>
    internal int CheckCount { get; private set; }

    /// <inheritdoc/>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _ = await this.CheckAndApplyAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                this.logger.LogError(ex, "Update cycle failed");
            }

            try
            {
                await Task.Delay(this.opts.CurrentValue.UpdateCheckInterval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>Performs a single fetch/verify/apply cycle.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The terminal outcome.</returns>
    public async ValueTask<UpdateOutcome> CheckAndApplyAsync(CancellationToken ct)
    {
        this.CheckCount++;
        var o = this.opts.CurrentValue;
        SignedReleaseManifest mfst;
        try
        {
            mfst = await this.fetcher.FetchAsync(o.ReleaseManifestUrl, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            this.logger.LogWarning(ex, "Manifest fetch network failure");
            await this.AuditAsync("DaemonUpdateRejected", "Failed_Network", ex.Message, ct).ConfigureAwait(false);
            return UpdateOutcome.Failed_Network;
        }

        var verified = await this.fetcher.VerifyAsync(mfst, o.OfflineRootPubKey, o.MinValidSignatures, ct).ConfigureAwait(false);
        if (!verified)
        {
            await this.AuditAsync("DaemonUpdateRejected", "Rejected_BadSignature", $"version={mfst.Version}", ct).ConfigureAwait(false);
            return UpdateOutcome.Rejected_BadSignature;
        }

        await this.MaybeEmitKeyRolloverAsync(mfst, ct).ConfigureAwait(false);

        var current = CurrentInstalledVersion();
        if (mfst.Version <= current)
        {
            await this.AuditAsync("DaemonUpdateRejected", "Rejected_VersionRegression", $"current={current},manifest={mfst.Version}", ct).ConfigureAwait(false);
            return UpdateOutcome.Rejected_VersionRegression;
        }

        if (current < mfst.MinSupportedVersion)
        {
            await this.AuditAsync("DaemonUpdateRejected", "Rejected_DowngradeBlocked", $"current={current},min={mfst.MinSupportedVersion}", ct).ConfigureAwait(false);
            return UpdateOutcome.Rejected_DowngradeBlocked;
        }

        AbsolutePath backup;
        try
        {
            await this.DownloadAndVerifyAsync(mfst, o.UpdateStagingRoot, ct).ConfigureAwait(false);
            backup = await this.swap.SwapAsync(o.InstallRoot, o.UpdateStagingRoot, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            this.logger.LogWarning(ex, "Artifact download failed");
            await this.AuditAsync("DaemonUpdateRejected", "Failed_Network", ex.Message, ct).ConfigureAwait(false);
            return UpdateOutcome.Failed_Network;
        }
        catch (IOException ex)
        {
            this.logger.LogError(ex, "Disk error during update");
            await this.AuditAsync("DaemonUpdateRejected", "Failed_Disk", ex.Message, ct).ConfigureAwait(false);
            return UpdateOutcome.Failed_Disk;
        }

        var exe = o.DaemonExecutable ?? new AbsolutePath(System.IO.Path.Combine(o.InstallRoot.Value, "aio-daemon"));
        var hr = await this.health.RunAsync(exe, ct).ConfigureAwait(false);
        if (!hr.Ok)
        {
            try
            {
                await this.swap.RollbackAsync(o.InstallRoot, backup, ct).ConfigureAwait(false);
            }
            catch (IOException ex)
            {
                this.logger.LogError(ex, "Rollback IO failure");
            }

            await this.AuditAsync("DaemonUpdateRolledBack", "RolledBack", hr.FailureReason ?? "health-fail", ct).ConfigureAwait(false);
            return UpdateOutcome.RolledBack;
        }

        await this.AuditAsync("DaemonUpdateApplied", "Applied", $"version={mfst.Version}", ct).ConfigureAwait(false);
        return UpdateOutcome.Applied;
    }

    private static Version CurrentInstalledVersion()
    {
        var v = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0, 0);
        return v;
    }

    private async ValueTask DownloadAndVerifyAsync(SignedReleaseManifest mfst, AbsolutePath stagingRoot, CancellationToken ct)
    {
        await this.fs.CreateDirectoryAsync(stagingRoot, ct).ConfigureAwait(false);
        using var client = this.http.CreateClient(nameof(UpdateController));
        foreach (var artifact in mfst.Artifacts)
        {
            var bytes = await client.GetByteArrayAsync(artifact.DownloadUrl, ct).ConfigureAwait(false);
            var actual = SHA256.HashData(bytes);
            var actualHex = Convert.ToHexString(actual).ToLowerInvariant();
            if (!string.Equals(actualHex, artifact.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new IOException($"SHA-256 mismatch for {artifact.Filename}: expected {artifact.Sha256}, got {actualHex}");
            }

            var dest = new AbsolutePath(System.IO.Path.Combine(stagingRoot.Value, artifact.Filename));
            await this.fs.WriteAllBytesAsync(dest, bytes, ct).ConfigureAwait(false);
        }
    }

    private async ValueTask MaybeEmitKeyRolloverAsync(SignedReleaseManifest mfst, CancellationToken ct)
    {
        var current = mfst.TrustedAuditPubKeys
            .Select(static k => Convert.ToHexString(k))
            .ToHashSet(StringComparer.Ordinal);
        if (this.lastObservedKeys is null)
        {
            this.lastObservedKeys = current;
            return;
        }

        if (!this.lastObservedKeys.SetEquals(current))
        {
            this.lastObservedKeys = current;
            using var sha = SHA256.Create();
            var fingerprint = mfst.TrustedAuditPubKeys.Length > 0
                ? sha.ComputeHash(mfst.TrustedAuditPubKeys[0])
                : Array.Empty<byte>();
            await this.bus.PublishAsync(
                new BuildKeyRolloverObserved
                {
                    ObservedManifestVersion = mfst.Version.ToString(),
                    ManifestSignerFingerprint = fingerprint,
                    At = this.clock.UtcNow,
                },
                ct).ConfigureAwait(false);
        }
    }

    private async ValueTask AuditAsync(string eventType, string outcome, string detail, CancellationToken ct)
    {
        var content = JsonSerializer.Serialize(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["outcome"] = outcome,
            ["detail"] = detail,
        });
        await this.audit.AppendAsync(
            new AuditRecord
            {
                EventType = eventType,
                At = this.clock.UtcNow,
                Principal = SystemPrincipal,
                ContentJson = content,
                ResourceRefs = ImmutableArray<string>.Empty,
            },
            ct).ConfigureAwait(false);
    }
}
