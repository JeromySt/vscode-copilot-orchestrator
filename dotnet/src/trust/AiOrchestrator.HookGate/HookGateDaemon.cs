// <copyright file="HookGateDaemon.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Audit;
using AiOrchestrator.HookGate.Exceptions;
using AiOrchestrator.HookGate.Nonce;
using AiOrchestrator.HookGate.Redirection;
using AiOrchestrator.HookGate.Rpc;
using AiOrchestrator.HookGate.Validation;
using AiOrchestrator.Models.Auth;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.HookGate;

/// <summary>
/// Out-of-process hook-gate daemon (§3.8 / §3.31.1.0 v1.4). Owns the nonce manager, an RPC
/// listener (UDS on POSIX, named pipe on Windows), the per-OS redirection manager, and the
/// link validator. On every check-in the daemon performs tamper checks (INV-4), computes an
/// HMAC-SHA256 approval token keyed by the current nonce (INV-6), and audits the outcome
/// (INV-7). Denied check-ins raise <see cref="HookApprovalDeniedException"/>.
/// </summary>
public sealed class HookGateDaemon : IHostedService, IAsyncDisposable
{
    private readonly INonceManager nonces;
    private readonly IRpcServer rpc;
    private readonly IRedirectionManager redirect;
    private readonly IClock clock;
    private readonly IEventBus bus;
    private readonly IOptionsMonitor<HookGateOptions> opts;
    private readonly ILogger<HookGateDaemon> logger;
    private readonly IAuditLog audit;
    private readonly LinkValidator validator;
    private int disposed;
    private int running;

    /// <summary>Initializes a new <see cref="HookGateDaemon"/>.</summary>
    public HookGateDaemon(
        INonceManager nonces,
        IRpcServer rpc,
        IRedirectionManager redirect,
        IClock clock,
        IEventBus bus,
        IOptionsMonitor<HookGateOptions> opts,
        ILogger<HookGateDaemon> logger,
        IAuditLog audit,
        IFileSystem fs)
    {
        this.nonces = nonces ?? throw new ArgumentNullException(nameof(nonces));
        this.rpc = rpc ?? throw new ArgumentNullException(nameof(rpc));
        this.redirect = redirect ?? throw new ArgumentNullException(nameof(redirect));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.bus = bus ?? throw new ArgumentNullException(nameof(bus));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
        this.audit = audit ?? throw new ArgumentNullException(nameof(audit));
        this.validator = new LinkValidator(fs ?? throw new ArgumentNullException(nameof(fs)));
    }

    /// <summary>Gets the number of per-message peer-credential checks performed (INV-1).</summary>
    public long PeerCredChecksPerformed => this.rpc.PeerCredChecksPerformed;

    /// <summary>
    /// Test-only entry point that validates a check-in and issues (or denies) an approval
    /// using the same logic the RPC layer would invoke per-message.
    /// </summary>
    /// <param name="request">The inbound check-in.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The approval issued by the daemon.</returns>
    public ValueTask<HookApproval> HandleCheckInAsync(HookCheckInRequest request, CancellationToken ct)
        => this.ProcessAsync(request, ct);

    /// <inheritdoc/>
    public async Task StartAsync(CancellationToken ct)
    {
        ValidateSocketPathPerms(this.opts.CurrentValue.SocketPath.Value);
        _ = System.Threading.Interlocked.Exchange(ref this.running, 1);
        await this.rpc.StartAsync(this.ProcessAsync, ct).ConfigureAwait(false);
        this.logger.LogInformation("HookGateDaemon started; nonce rotation {Rotation}, TTL {Ttl}.",
            this.opts.CurrentValue.NonceRotation,
            this.opts.CurrentValue.ApprovalTokenTtl);
    }

    /// <inheritdoc/>
    public async Task StopAsync(CancellationToken ct)
    {
        _ = System.Threading.Interlocked.Exchange(ref this.running, 0);
        await this.rpc.StopAsync(ct).ConfigureAwait(false);
        this.logger.LogInformation("HookGateDaemon stopped.");
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (System.Threading.Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        await this.rpc.DisposeAsync().ConfigureAwait(false);
    }

    internal async ValueTask<HookApproval> ProcessAsync(HookCheckInRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (System.Threading.Interlocked.CompareExchange(ref this.running, 0, 0) == 0)
        {
            await this.DenyAsync(request, "daemon shutting down", ct).ConfigureAwait(false);
            throw new HookApprovalDeniedException("daemon shutting down", request.Kind);
        }

        var hookAbs = new AiOrchestrator.Models.Paths.AbsolutePath(
            System.IO.Path.GetFullPath(System.IO.Path.Combine(request.WorktreeRoot.Value, request.HookFile.Value)));

        var linkResult = await this.validator.ValidateAsync(hookAbs, request.WorktreeRoot, ct).ConfigureAwait(false);
        if (!linkResult.Ok)
        {
            var reason = linkResult.FailureReason ?? "link validation failed";
            await this.DenyAsync(request, reason, ct).ConfigureAwait(false);
            throw new HookApprovalDeniedException(reason, request.Kind);
        }

        var current = this.nonces.Current;
        var approval = ApprovalIssuer.Issue(current, request, this.clock.UtcNow, this.opts.CurrentValue.ApprovalTokenTtl);
        await this.audit.AppendAsync(
            new AuditRecord
            {
                EventType = "hook.approve",
                At = this.clock.UtcNow,
                Principal = request.Principal,
                ContentJson = $"{{\"kind\":\"{request.Kind}\",\"tokenId\":\"{approval.TokenId}\"}}",
                ResourceRefs = ImmutableArray.Create(request.HookFile.Value),
            },
            ct).ConfigureAwait(false);
        return approval;
    }

    private async ValueTask DenyAsync(HookCheckInRequest request, string reason, CancellationToken ct)
    {
        this.logger.LogWarning("Hook check-in denied: kind={Kind} reason={Reason}", request.Kind, reason);
        await this.audit.AppendAsync(
            new AuditRecord
            {
                EventType = "hook.deny",
                At = this.clock.UtcNow,
                Principal = request.Principal,
                ContentJson = $"{{\"kind\":\"{request.Kind}\",\"reason\":\"{reason}\"}}",
                ResourceRefs = ImmutableArray.Create(request.HookFile.Value),
            },
            ct).ConfigureAwait(false);
    }

    [ExcludeFromCodeCoverage(Justification = "POSIX-only socket-perms check (INV-8); covered by Linux CI only.")]
    private static void ValidateSocketPathPerms(string socketPath)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return;
        }

        var parent = System.IO.Path.GetDirectoryName(socketPath);
        if (string.IsNullOrEmpty(parent) || !System.IO.Directory.Exists(parent))
        {
            return;
        }

        try
        {
            var mode = System.IO.File.GetUnixFileMode(parent);
            const UnixFileMode OwnerOnly =
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
            var broad = mode & ~OwnerOnly;
            if (broad != 0)
            {
                throw new InvalidOperationException(
                    $"HookGate socket parent directory '{parent}' has permissions {mode:D} broader than 0700 (INV-8).");
            }
        }
        catch (IOException)
        {
            // treat unreadable mode as unsafe — fail closed
            throw new InvalidOperationException($"HookGate socket parent directory '{parent}' permissions cannot be read (INV-8).");
        }
        catch (PlatformNotSupportedException)
        {
            // older runtimes — fall through without check
        }
    }
}
