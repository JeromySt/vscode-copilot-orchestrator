// <copyright file="TransportSession.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Mcp;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.VsCode.Transport;

/// <summary>
/// A per-window VS Code transport session. Owns a private <see cref="HandleScope"/>
/// (INV-2), multiplexes orchestrator events through <see cref="WatchEventsAsync"/>
/// (INV-4), routes tool invocations through the MCP tool registry (INV-5), and
/// enforces an idle-timeout auto-disposal (INV-3).
/// </summary>
public sealed class TransportSession : IAsyncDisposable
{
    private readonly McpToolRegistry registry;
    private readonly IClock clock;
    private readonly TransportOptions options;
    private readonly ILogger logger;
    private readonly Channel<TransportEvent> events;
    private readonly CancellationTokenSource lifetimeCts = new();
    private readonly Timer idleTimer;
    private long lastActivityMs;
    private int disposed;

    internal TransportSession(
        VsCodeWindowId windowId,
        HandleScope scope,
        McpToolRegistry registry,
        IClock clock,
        TransportOptions options,
        ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);

        this.WindowId = windowId;
        this.Scope = scope;
        this.registry = registry;
        this.clock = clock;
        this.options = options;
        this.logger = logger;
        this.events = Channel.CreateUnbounded<TransportEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        this.lastActivityMs = clock.MonotonicMilliseconds;

        // Poll at 1/10th of the idle timeout, bounded between 100ms and 60s so the
        // auto-dispose latency is predictable for both production (30-min timeouts)
        // and tests (which prefer sub-second idle windows).
        long periodMs = Math.Max(100L, Math.Min(60_000L, (long)(options.SessionIdleTimeout.TotalMilliseconds / 10.0)));
        this.idleTimer = new Timer(this.OnIdleTick, null, periodMs, periodMs);
    }

    /// <summary>Gets the VS Code window identifier owning this session.</summary>
    public required VsCodeWindowId WindowId { get; init; }

    /// <summary>Gets the per-session handle scope. Disposal of the session disposes this scope (INV-2).</summary>
    public required HandleScope Scope { get; init; }

    /// <summary>Gets a value indicating whether the session has been disposed (for diagnostics).</summary>
    public bool IsDisposed => Volatile.Read(ref this.disposed) != 0;

    /// <summary>
    /// Invokes an MCP-registered tool. Errors crossing the boundary preserve the .NET exception
    /// type name in <c>error.code</c> (INV-8). Cancellation is propagated through to the
    /// orchestrator (INV-7).
    /// </summary>
    /// <param name="toolName">The registered MCP tool name.</param>
    /// <param name="parameters">The tool parameters as a JSON object.</param>
    /// <param name="ct">Cancellation token propagated from VS Code.</param>
    /// <returns>The tool's JSON result, or an error envelope with <c>code</c> + <c>message</c>.</returns>
    public async ValueTask<JsonNode> InvokeToolAsync(string toolName, JsonElement parameters, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(toolName);
        this.ThrowIfDisposed();
        this.Touch();

        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(ct, this.lifetimeCts.Token);

        try
        {
            return await this.registry.InvokeAsync(toolName, parameters, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // INV-7: surface cancellation as-is; callers decide whether it originated from VS Code
            // (ct) or the session's own shutdown (lifetimeCts).
            throw;
        }
#pragma warning disable CA1031 // Catch-all needed to preserve .NET type name across boundary (INV-8).
        catch (Exception ex)
        {
            this.logger.LogWarning(ex, "VS Code tool invocation '{Tool}' failed on window {Window}.", toolName, this.WindowId.Value);
            return new JsonObject
            {
                ["error"] = new JsonObject
                {
                    ["code"] = ex.GetType().Name,
                    ["message"] = ex.Message,
                },
            };
        }
#pragma warning restore CA1031
    }

    /// <summary>
    /// Streams events multiplexed from the orchestrator. The iterator completes when the session
    /// is disposed or <paramref name="ct"/> is cancelled (INV-4).
    /// </summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An async iterator of <see cref="TransportEvent"/>s.</returns>
    public async IAsyncEnumerable<TransportEvent> WatchEventsAsync([EnumeratorCancellation] CancellationToken ct)
    {
        this.ThrowIfDisposed();

        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(ct, this.lifetimeCts.Token);
        while (!linked.IsCancellationRequested)
        {
            TransportEvent? evt = null;
            try
            {
                evt = await this.events.Reader.ReadAsync(linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }
            catch (ChannelClosedException)
            {
                yield break;
            }

            yield return evt;
        }
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        await this.lifetimeCts.CancelAsync().ConfigureAwait(false);
        _ = this.events.Writer.TryComplete();
        await this.idleTimer.DisposeAsync().ConfigureAwait(false);

        // INV-2: disposing the session disposes the scope and every handle it owns.
        await this.Scope.DisposeAsync().ConfigureAwait(false);

        this.lifetimeCts.Dispose();
    }

    /// <summary>Publishes an orchestrator event into the session's event stream (used by the host).</summary>
    /// <param name="evt">The event to publish.</param>
    /// <returns><see langword="true"/> if the event was enqueued; <see langword="false"/> when the session is closed.</returns>
    public bool Publish(TransportEvent evt)
    {
        ArgumentNullException.ThrowIfNull(evt);
        if (Volatile.Read(ref this.disposed) != 0)
        {
            return false;
        }

        this.Touch();

        if (!this.events.Writer.TryWrite(evt))
        {
            return false;
        }

        if (this.options.EnableProgressNotifications && IsProgressKind(evt.Kind))
        {
            // INV-6: progress-style events are additionally emitted as MCP 'progress' notifications.
            // The concrete MCP wire is owned by the transport's McpToolRegistry/server; here we
            // simply mark the bridge via a structured log line so test doubles can observe it.
            this.logger.LogInformation(
                "mcp.progress window={Window} kind={Kind} at={At:o}",
                this.WindowId.Value,
                evt.Kind,
                evt.At);
        }

        return true;
    }

    private static bool IsProgressKind(string kind) =>
        kind.StartsWith("plan.progress", StringComparison.Ordinal) ||
        kind.StartsWith("job.progress", StringComparison.Ordinal) ||
        kind.StartsWith("progress", StringComparison.Ordinal);

    private void Touch() => Volatile.Write(ref this.lastActivityMs, this.clock.MonotonicMilliseconds);

    private void OnIdleTick(object? state)
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            return;
        }

        long idleMs = this.clock.MonotonicMilliseconds - Volatile.Read(ref this.lastActivityMs);
        if (idleMs >= (long)this.options.SessionIdleTimeout.TotalMilliseconds)
        {
            this.logger.LogInformation("Idle timeout fired on window {Window}; auto-disposing session.", this.WindowId.Value);

            // Fire-and-forget: the timer callback runs on the thread pool and is invoked at most
            // once per session because DisposeAsync flips the `disposed` flag atomically.
            _ = Task.Run(async () =>
            {
                try
                {
                    await this.DisposeAsync().ConfigureAwait(false);
                }
#pragma warning disable CA1031
                catch (Exception ex)
                {
                    this.logger.LogError(ex, "Idle auto-dispose failed for window {Window}.", this.WindowId.Value);
                }
#pragma warning restore CA1031
            });
        }
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(TransportSession));
        }
    }
}
