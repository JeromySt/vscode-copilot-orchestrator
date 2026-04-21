// <copyright file="CredentialBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Globalization;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.Credentials.Allowlist;
using AiOrchestrator.Credentials.Backoff;
using AiOrchestrator.Credentials.Gcm;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Credentials;

/// <summary>
/// Brokers OS-keychain access for git via Git Credential Manager (GCM), per §3.6 + §3.31.1.1.
/// Enforces the URL allowlist (INV-1), runs the full <c>get</c>/<c>store</c>/<c>erase</c>
/// verb sequence (INV-5), wraps secrets in <see cref="ProtectedString"/> (INV-10), audits every
/// operation with PII-redacted URLs (INV-11), and engages exponential backoff on repeated
/// invalidation events (INV-7..9).
/// </summary>
public sealed class CredentialBroker : ICredentialBroker, IAsyncDisposable
{
    private readonly GcmInvoker gcm;
    private readonly HostAllowlistChecker allowlist;
    private readonly CredentialBackoffEngine backoff;
    private readonly IAuditLog audit;
    private readonly IClock clock;
    private readonly ILogger<CredentialBroker> logger;
    private int disposed;

    /// <summary>Initializes a new <see cref="CredentialBroker"/>.</summary>
    /// <param name="spawner">Process spawner used by <see cref="GcmInvoker"/>.</param>
    /// <param name="clock">Clock used for audit timestamps.</param>
    /// <param name="audit">Append-only audit log (INV-11).</param>
    /// <param name="opts">Options monitor (allowlist, timeouts, backoff).</param>
    /// <param name="logger">Logger; never sees secrets (INV-10 / CRED-PWD-LOG).</param>
    /// <param name="bus">Event bus for <see cref="CredentialBackoffEngaged"/> publication.</param>
    public CredentialBroker(
        IProcessSpawner spawner,
        IClock clock,
        IAuditLog audit,
        IOptionsMonitor<CredentialOptions> opts,
        ILogger<CredentialBroker> logger,
        IEventBus bus)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(bus);
        this.gcm = new GcmInvoker(spawner, opts);
        this.allowlist = new HostAllowlistChecker(opts);
        this.backoff = new CredentialBackoffEngine(clock, opts, bus);
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Test-only constructor that accepts an externally-owned backoff engine (for deterministic tests).</summary>
    /// <param name="spawner">Process spawner.</param>
    /// <param name="clock">Clock.</param>
    /// <param name="audit">Audit log.</param>
    /// <param name="opts">Options monitor.</param>
    /// <param name="logger">Logger.</param>
    /// <param name="backoff">Pre-built backoff engine.</param>
    internal CredentialBroker(
        IProcessSpawner spawner,
        IClock clock,
        IAuditLog audit,
        IOptionsMonitor<CredentialOptions> opts,
        ILogger<CredentialBroker> logger,
        CredentialBackoffEngine backoff)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(opts);
        this.gcm = new GcmInvoker(spawner, opts);
        this.allowlist = new HostAllowlistChecker(opts);
        this.backoff = backoff ?? throw new ArgumentNullException(nameof(backoff));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <inheritdoc/>
    public async ValueTask<Credential> GetAsync(Uri repoUrl, AuthContext principal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        ArgumentNullException.ThrowIfNull(principal);

        if (!this.allowlist.IsAllowed(repoUrl))
        {
            var ex = this.allowlist.CreateException(repoUrl);
            await this.AuditAsync("credential.get.denied", principal, repoUrl, AuditOutcomeKind.Denied, $"host_not_allowed:{repoUrl.Host}", ct).ConfigureAwait(false);
            this.logger.LogWarning("Credential request denied for {Host}: not in allowlist.", repoUrl.Host);
            throw ex;
        }

        if (!this.backoff.TryEnter(repoUrl, out var remaining))
        {
            await this.AuditAsync("credential.get.backoff", principal, repoUrl, AuditOutcomeKind.Failure, $"backoff_active_remaining_ms:{(long)remaining.TotalMilliseconds}", ct).ConfigureAwait(false);
            this.logger.LogInformation("Credential broker backing off for {Host}; remaining {RemainingMs} ms.", repoUrl.Host, (long)remaining.TotalMilliseconds);
            throw new CredentialBackoffActiveException(repoUrl, remaining);
        }

        try
        {
            var cred = await this.gcm.GetAsync(repoUrl, ct).ConfigureAwait(false);
            this.backoff.RecordSuccess(repoUrl);
            await this.AuditAsync("credential.get", principal, repoUrl, AuditOutcomeKind.Success, null, ct).ConfigureAwait(false);
            this.logger.LogInformation("Credential retrieved for {Host}; protocol={Protocol}.", repoUrl.Host, cred.SourceProtocol);
            return cred;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            this.backoff.RecordFailure(repoUrl);
            await this.AuditAsync("credential.get.failed", principal, repoUrl, AuditOutcomeKind.Failure, ex.GetType().Name, ct).ConfigureAwait(false);
            this.logger.LogWarning("Credential retrieval failed for {Host}: {Reason}.", repoUrl.Host, ex.GetType().Name);
            throw;
        }
    }

    /// <inheritdoc/>
    public async ValueTask StoreAsync(Uri repoUrl, Credential credential, AuthContext principal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        ArgumentNullException.ThrowIfNull(credential);
        ArgumentNullException.ThrowIfNull(principal);
        if (!this.allowlist.IsAllowed(repoUrl))
        {
            throw this.allowlist.CreateException(repoUrl);
        }

        try
        {
            await this.gcm.StoreAsync(repoUrl, credential, ct).ConfigureAwait(false);
            this.backoff.RecordSuccess(repoUrl);
            await this.AuditAsync("credential.store", principal, repoUrl, AuditOutcomeKind.Success, null, ct).ConfigureAwait(false);
            this.logger.LogInformation("Credential approved for {Host}.", repoUrl.Host);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await this.AuditAsync("credential.store.failed", principal, repoUrl, AuditOutcomeKind.Failure, ex.GetType().Name, ct).ConfigureAwait(false);
            throw;
        }
    }

    /// <inheritdoc/>
    public async ValueTask EraseAsync(Uri repoUrl, AuthContext principal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        ArgumentNullException.ThrowIfNull(principal);
        if (!this.allowlist.IsAllowed(repoUrl))
        {
            throw this.allowlist.CreateException(repoUrl);
        }

        try
        {
            await this.gcm.EraseAsync(repoUrl, ct).ConfigureAwait(false);

            // Erase is called after auth failure; count as an invalidation event for backoff.
            this.backoff.RecordFailure(repoUrl);
            await this.AuditAsync("credential.erase", principal, repoUrl, AuditOutcomeKind.Success, null, ct).ConfigureAwait(false);
            this.logger.LogInformation("Credential erased for {Host}.", repoUrl.Host);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await this.AuditAsync("credential.erase.failed", principal, repoUrl, AuditOutcomeKind.Failure, ex.GetType().Name, ct).ConfigureAwait(false);
            throw;
        }
    }

    /// <inheritdoc/>
    public ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        return ValueTask.CompletedTask;
    }

    /// <summary>Strips userinfo/query and path to the first segment to avoid leaking PII/tokens in audit logs (INV-11).</summary>
    /// <param name="url">The URL to redact.</param>
    /// <returns>A redacted URL suitable for inclusion in audit records.</returns>
    internal static string RedactForAudit(Uri url)
    {
        // Keep only scheme + host; drop userinfo, path, query, fragment.
        return string.Create(CultureInfo.InvariantCulture, $"{url.Scheme}://{url.Host}");
    }

    private ValueTask AuditAsync(string evtType, AuthContext principal, Uri url, AuditOutcomeKind outcome, string? detail, CancellationToken ct)
    {
        var record = new AuditRecord
        {
            EventType = evtType,
            At = this.clock.UtcNow,
            Principal = principal,
            ContentJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                url = RedactForAudit(url),
                outcome = outcome.ToString(),
                detail,
            }),
            ResourceRefs = ImmutableArray.Create(RedactForAudit(url)),
        };
        return this.audit.AppendAsync(record, ct);
    }
}

/// <summary>Outcome classification used in credential audit records (internal).</summary>
internal enum AuditOutcomeKind
{
    /// <summary>Operation succeeded.</summary>
    Success,

    /// <summary>Operation failed due to a runtime error.</summary>
    Failure,

    /// <summary>Operation was denied by policy (e.g., allowlist).</summary>
    Denied,
}

/// <summary>Thrown when a credential request is blocked by active exponential backoff (INV-7).</summary>
public sealed class CredentialBackoffActiveException : Exception
{
    /// <summary>Initializes a new <see cref="CredentialBackoffActiveException"/>.</summary>
    /// <param name="url">The URL currently in backoff.</param>
    /// <param name="remainingDelay">Time remaining until the next attempt is permitted.</param>
    public CredentialBackoffActiveException(Uri url, TimeSpan remainingDelay)
        : base($"Credential broker is backing off for '{url?.Host}'; retry after {remainingDelay}.")
    {
        this.Url = url ?? throw new ArgumentNullException(nameof(url));
        this.RemainingDelay = remainingDelay;
    }

    /// <summary>Gets the URL that triggered backoff.</summary>
    public Uri Url { get; }

    /// <summary>Gets the remaining backoff delay.</summary>
    public TimeSpan RemainingDelay { get; }
}
