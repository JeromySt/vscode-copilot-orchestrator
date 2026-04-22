// <copyright file="SkewManifestObserver.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.SkewManifest.Verification;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.SkewManifest;

/// <summary>
/// Periodically fetches the release-manifest over HTTPS, verifies the HSM M-of-N
/// signature chain, checks the transparency log and publishes
/// <see cref="SkewManifestUpdated"/> / <see cref="SkewManifestStale"/> events.
/// </summary>
public sealed class SkewManifestObserver : IHostedService, IAsyncDisposable
{
    private static readonly TimeSpan ClockSkewTolerance = TimeSpan.FromMinutes(5);

    private readonly IHttpClientFactory http;
#pragma warning disable CA1823, IDE0052
    private readonly IFileSystem fs;
#pragma warning restore CA1823, IDE0052
    private readonly IClock clock;
    private readonly IAuditLog audit;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<SkewManifestOptions> opts;
    private readonly ILogger<SkewManifestObserver> logger;
    private readonly HsmSignatureVerifier verifier;
    private readonly TransparencyLogChecker transparency;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource cts = new();

    private SkewManifest? current;
    private Version? lastManifestVersion;
    private Task? loop;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="SkewManifestObserver"/> class.</summary>
    /// <param name="http">HTTP client factory for fetching the manifest and talking to the transparency log.</param>
    /// <param name="fs">File system abstraction.</param>
    /// <param name="clock">Clock used for expiry/staleness decisions.</param>
    /// <param name="audit">Tamper-evident audit log; every fetch is recorded.</param>
    /// <param name="bus">Event bus for publishing <see cref="SkewManifestUpdated"/> / <see cref="SkewManifestStale"/>.</param>
    /// <param name="opts">Live options monitor.</param>
    /// <param name="logger">Logger.</param>
    public SkewManifestObserver(
        IHttpClientFactory http,
        IFileSystem fs,
        IClock clock,
        IAuditLog audit,
        IEventBus bus,
        IOptionsMonitor<SkewManifestOptions> opts,
        ILogger<SkewManifestObserver> logger)
    {
        this.http = http ?? throw new ArgumentNullException(nameof(http));
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
        this.verifier = new HsmSignatureVerifier(opts);
        this.transparency = new TransparencyLogChecker(http, clock, opts);
    }

    /// <summary>Starts the background polling loop.</summary>
    /// <param name="ct">Startup cancellation token.</param>
    /// <returns>A completed task.</returns>
    public Task StartAsync(CancellationToken ct)
    {
        this.loop = Task.Run(() => this.RunLoopAsync(this.cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <summary>Stops the background polling loop and waits for it to exit.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Task completing when the loop has exited.</returns>
    public async Task StopAsync(CancellationToken ct)
    {
        await this.cts.CancelAsync().ConfigureAwait(false);
        var running = this.loop;
        if (running is not null)
        {
            try
            {
                await running.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
        }
    }

    /// <summary>Gets the currently-active manifest, if any.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The current manifest or <see langword="null"/>.</returns>
    public ValueTask<SkewManifest?> CurrentAsync(CancellationToken ct) => new(this.current);

    /// <summary>Verifies a manifest against the configured burn-in HSM set and transparency log.</summary>
    /// <param name="manifest">The manifest to verify.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The verification outcome.</returns>
    public async ValueTask<SkewManifestVerification> VerifyAsync(SkewManifest manifest, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var now = this.clock.UtcNow;

        // INV-2: expiry / future clock skew
        if (manifest.SignedAt > now + ClockSkewTolerance)
        {
            return Reject(SkewManifestRejectionReason.ExpiredManifest, "SignedAt is beyond clock-skew tolerance.");
        }

        if (manifest.NotValidAfter < now)
        {
            return Reject(SkewManifestRejectionReason.ExpiredManifest, "NotValidAfter has elapsed.");
        }

        // INV-6: monotonic version
        if (this.lastManifestVersion is not null && manifest.ManifestVersion <= this.lastManifestVersion)
        {
            return Reject(SkewManifestRejectionReason.VersionRegression, $"Seen {this.lastManifestVersion}, fetched {manifest.ManifestVersion}.");
        }

        // INV-5: all signatures must reference known HSM pubkeys via a matching signature.
        var options = this.opts.CurrentValue;
        foreach (var s in manifest.HsmSignatures)
        {
            if (!string.Equals(s.Algorithm, "ECDSA-P256", StringComparison.Ordinal))
            {
                return Reject(SkewManifestRejectionReason.InvalidSignature, $"Unsupported algorithm: {s.Algorithm}");
            }

            var payload = CanonicalPayload.ComputeForSignature(manifest);
            if (!MatchesAnyKnownKey(s, payload, options.KnownHsmPublicKeys))
            {
                return Reject(SkewManifestRejectionReason.UnknownHsmSigner, $"HSM '{s.HsmId}' has no matching burn-in key.");
            }
        }

        // INV-4: M-of-N
        if (!this.verifier.TryVerify(manifest, out var validCount, out var detail))
        {
            return Reject(SkewManifestRejectionReason.InsufficientSignatures, detail ?? $"Only {validCount} valid signatures (need {options.RequiredHsmSignatures}).");
        }

        // INV-7: emergency revocation must verify against emergency keys
        if (manifest.EmergencyRevocation is { } rev)
        {
            if (!VerifyEmergencyRevocation(rev, options))
            {
                return Reject(SkewManifestRejectionReason.EmergencyRevocationInvalid, "Emergency revocation failed M-of-N verification against emergency key set.");
            }
        }

        // INV-8: transparency log
        var tlog = await this.transparency.CheckAsync(manifest, ct).ConfigureAwait(false);
        if (!tlog.Included)
        {
            return Reject(SkewManifestRejectionReason.TransparencyLogMismatch, tlog.FailureReason ?? "Not found.");
        }

        return new SkewManifestVerification { Ok = true, Reason = null, Detail = $"{validCount} valid HSM signatures." };
    }

    /// <summary>Disposes the observer.</summary>
    /// <returns>A completed <see cref="ValueTask"/>.</returns>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) == 1)
        {
            return;
        }

        try
        {
            await this.cts.CancelAsync().ConfigureAwait(false);
        }
        catch (ObjectDisposedException)
        {
            // already disposed
        }

        var running = this.loop;
        if (running is not null)
        {
            try
            {
                await running.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
            catch (System.Exception)
            {
                // best effort
            }
        }

        this.gate.Dispose();
        this.cts.Dispose();
    }

    internal async Task<SkewManifestVerification> FetchOnceAsync(CancellationToken ct)
    {
        var options = this.opts.CurrentValue;
        SkewManifest? fetched = null;
        SkewManifestVerification verification;
        try
        {
            using var client = this.http.CreateClient("skew-manifest");
            fetched = await client.GetFromJsonAsync<SkewManifest>(options.ManifestUrl, ct).ConfigureAwait(false)
                ?? throw new InvalidOperationException("Manifest payload was empty.");

            verification = await this.VerifyAsync(fetched, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            verification = Reject(SkewManifestRejectionReason.InvalidSignature, $"Fetch failed: {ex.Message}");
        }
        catch (System.Text.Json.JsonException ex)
        {
            verification = Reject(SkewManifestRejectionReason.InvalidSignature, $"Deserialization failed: {ex.Message}");
        }

        if (verification.Ok && fetched is not null)
        {
            await this.gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                this.current = fetched;
                this.lastManifestVersion = fetched.ManifestVersion;
            }
            finally
            {
                this.gate.Release();
            }

            await this.bus.PublishAsync(
                new SkewManifestUpdated { ManifestVersion = fetched.ManifestVersion, FetchedAt = this.clock.UtcNow },
                ct).ConfigureAwait(false);
        }

        await this.AuditAsync(fetched, verification, ct).ConfigureAwait(false);
        await this.CheckStaleAsync(ct).ConfigureAwait(false);
        return verification;
    }

    private static bool MatchesAnyKnownKey(HsmSignature sig, byte[] payload, ImmutableArray<byte[]> knownKeys)
    {
        foreach (var pub in knownKeys)
        {
            try
            {
                using var ecdsa = System.Security.Cryptography.ECDsa.Create();
                ecdsa.ImportSubjectPublicKeyInfo(pub, out _);
                if (ecdsa.VerifyData(payload, sig.Signature, System.Security.Cryptography.HashAlgorithmName.SHA256))
                {
                    return true;
                }
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                continue;
            }
        }

        return false;
    }

    private static bool VerifyEmergencyRevocation(EmergencyRevocation rev, SkewManifestOptions options)
    {
        var payload = CanonicalPayload.ComputeForEmergencyRevocationSignature(rev);
        var validSigners = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
        foreach (var sig in rev.AdditionalSignatures)
        {
            foreach (var pub in options.EmergencyRevocationPublicKeys)
            {
                try
                {
                    using var ecdsa = System.Security.Cryptography.ECDsa.Create();
                    ecdsa.ImportSubjectPublicKeyInfo(pub, out _);
                    if (ecdsa.VerifyData(payload, sig.Signature, System.Security.Cryptography.HashAlgorithmName.SHA256))
                    {
                        validSigners.Add(Convert.ToHexString(pub));
                        break;
                    }
                }
                catch (System.Security.Cryptography.CryptographicException)
                {
                    continue;
                }
            }
        }

        return validSigners.Count >= options.RequiredHsmSignatures;
    }

    private static SkewManifestVerification Reject(SkewManifestRejectionReason reason, string detail) =>
        new() { Ok = false, Reason = reason, Detail = detail };

    private async Task RunLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await this.FetchOnceAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (System.Exception ex)
            {
                this.logger.LogWarning(ex, "Skew manifest fetch loop iteration failed.");
            }

            try
            {
                await Task.Delay(this.opts.CurrentValue.PollInterval, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task AuditAsync(SkewManifest? manifest, SkewManifestVerification verification, CancellationToken ct)
    {
        try
        {
            var eventType = verification.Ok ? "skew.manifest.verified" : "skew.manifest.rejected";
            var content = System.Text.Json.JsonSerializer.Serialize(new
            {
                ok = verification.Ok,
                reason = verification.Reason?.ToString(),
                detail = verification.Detail,
                manifestVersion = manifest?.ManifestVersion?.ToString(),
                signedAt = manifest?.SignedAt,
            });
            await this.audit.AppendAsync(
                new AuditRecord
                {
                    EventType = eventType,
                    At = this.clock.UtcNow,
                    Principal = new AuthContext
                    {
                        PrincipalId = "system:skew-manifest-observer",
                        DisplayName = "Skew Manifest Observer",
                        Scopes = ImmutableArray.Create("skew-manifest.fetch"),
                    },
                    ContentJson = content,
                    ResourceRefs = ImmutableArray<string>.Empty,
                },
                ct).ConfigureAwait(false);
        }
        catch (System.Exception ex)
        {
            this.logger.LogWarning(ex, "Failed to audit skew manifest fetch.");
        }
    }

    private async Task CheckStaleAsync(CancellationToken ct)
    {
        var cur = this.current;
        if (cur is null)
        {
            return;
        }

        var now = this.clock.UtcNow;
        if (now - cur.SignedAt > this.opts.CurrentValue.StaleAfter)
        {
            await this.bus.PublishAsync(
                new SkewManifestStale { SignedAt = cur.SignedAt, ObservedAt = now },
                ct).ConfigureAwait(false);
        }
    }
}
