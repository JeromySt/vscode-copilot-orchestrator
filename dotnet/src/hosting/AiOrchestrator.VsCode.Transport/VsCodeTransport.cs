// <copyright file="VsCodeTransport.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Mcp;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.VsCode.Transport;

/// <summary>
/// The VS Code transport entry point (job 040 / §4.6). Creates per-window
/// <see cref="TransportSession"/>s, each with its own <see cref="HandleScope"/>.
/// Tool invocations are routed through the MCP tool registry (INV-5); events
/// and progress are multiplexed onto the session's event stream (INV-4 / INV-6).
/// </summary>
public sealed class VsCodeTransport : IAsyncDisposable
{
    private readonly NodeBindingsHost bindings;
    private readonly McpServer mcp;
    private readonly IClock clock;
    private readonly IOptionsMonitor<TransportOptions> opts;
    private readonly ILogger<VsCodeTransport> logger;
    private readonly ConcurrentDictionary<string, TransportSession> sessions = new(StringComparer.Ordinal);
    private readonly McpToolRegistry registry;
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="VsCodeTransport"/> class.</summary>
    /// <param name="bindings">The Node-side N-API bindings host (job 036) used to mint handles.</param>
    /// <param name="mcp">The MCP server (job 035) through which tool invocations are routed.</param>
    /// <param name="clock">Ambient clock used to drive the idle-timeout logic.</param>
    /// <param name="opts">Bindable transport options.</param>
    /// <param name="logger">Logger used for diagnostic output.</param>
    public VsCodeTransport(
        NodeBindingsHost bindings,
        McpServer mcp,
        IClock clock,
        IOptionsMonitor<TransportOptions> opts,
        ILogger<VsCodeTransport> logger)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(mcp);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);

        this.bindings = bindings;
        this.mcp = mcp;
        this.clock = clock;
        this.opts = opts;
        this.logger = logger;
        this.registry = mcp.Registry;
    }

    /// <summary>
    /// Creates a new <see cref="TransportSession"/> for a VS Code window. Each window gets
    /// its own isolated <see cref="HandleScope"/> so lifetime boundaries are explicit (INV-2).
    /// </summary>
    /// <param name="windowId">The window identifier supplied by the extension host.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A new transport session.</returns>
    public ValueTask<TransportSession> CreateSessionAsync(VsCodeWindowId windowId, CancellationToken ct)
    {
        this.ThrowIfDisposed();
        ct.ThrowIfCancellationRequested();

        var scope = new HandleScope(this.bindings);
        var session = new TransportSession(windowId, scope, this.registry, this.clock, this.opts.CurrentValue, this.logger)
        {
            WindowId = windowId,
            Scope = scope,
        };

        // INV-2: each window has its own isolated session; collisions replace the prior session
        // (and dispose it) — VS Code always reuses the same windowId for the lifetime of a window.
        if (this.sessions.TryGetValue(windowId.Value, out TransportSession? existing))
        {
            _ = existing.DisposeAsync();
        }

        this.sessions[windowId.Value] = session;
        this.logger.LogInformation("Created VS Code transport session for window {Window}.", windowId.Value);

        return new ValueTask<TransportSession>(session);
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        foreach (TransportSession session in this.sessions.Values)
        {
            try
            {
                await session.DisposeAsync().ConfigureAwait(false);
            }
#pragma warning disable CA1031
            catch (Exception ex)
            {
                this.logger.LogWarning(ex, "Error disposing VS Code session for window {Window}.", session.WindowId.Value);
            }
#pragma warning restore CA1031
        }

        this.sessions.Clear();
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(VsCodeTransport));
        }
    }
}
