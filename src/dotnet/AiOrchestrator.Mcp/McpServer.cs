// <copyright file="McpServer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Mcp;

/// <summary>
/// JSON-RPC 2.0 MCP (Model Context Protocol) server. Reads requests from the configured
/// <see cref="IMcpTransport"/>, dispatches <c>tools/list</c> and <c>tools/call</c> to the
/// <see cref="McpToolRegistry"/>, and writes back responses with per-tool timeout enforcement.
/// </summary>
public sealed class McpServer : IHostedService, IAsyncDisposable
{
    private readonly McpToolRegistry registry;
    private readonly IMcpTransport transport;
    private readonly IOptionsMonitor<McpOptions> opts;
    private readonly ILogger<McpServer> logger;
    private readonly CancellationTokenSource shutdownCts = new();
    private Task? loop;

    /// <summary>Initializes a new instance of the <see cref="McpServer"/> class.</summary>
    /// <param name="registry">The tool registry.</param>
    /// <param name="transport">The transport carrying JSON-RPC envelopes.</param>
    /// <param name="opts">Monitor for <see cref="McpOptions"/>.</param>
    /// <param name="logger">Logger used for diagnostic output.</param>
    public McpServer(
        McpToolRegistry registry,
        IMcpTransport transport,
        IOptionsMonitor<McpOptions> opts,
        ILogger<McpServer> logger)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);

        this.registry = registry;
        this.transport = transport;
        this.opts = opts;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public Task StartAsync(CancellationToken ct)
    {
        this.loop = Task.Run(() => this.RunLoopAsync(this.shutdownCts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public async Task StopAsync(CancellationToken ct)
    {
        await this.shutdownCts.CancelAsync().ConfigureAwait(false);
        if (this.loop is not null)
        {
            try
            {
                await this.loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown.
            }
        }
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        await this.StopAsync(CancellationToken.None).ConfigureAwait(false);
        this.shutdownCts.Dispose();
    }

    internal async Task<JsonRpcEnvelope> HandleAsync(JsonRpcEnvelope request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.JsonRpc, "2.0", StringComparison.Ordinal))
        {
            return ErrorEnvelope(request.Id, -32600, "InvalidRequest: jsonrpc must be '2.0'.");
        }

        if (string.IsNullOrEmpty(request.Method))
        {
            return ErrorEnvelope(request.Id, -32600, "InvalidRequest: method is required.");
        }

        try
        {
            return request.Method switch
            {
                "initialize" => ResultEnvelope(request.Id, BuildInitializeResult()),
                "tools/list" => ResultEnvelope(request.Id, this.BuildToolList()),
                "tools/call" => await this.InvokeToolAsync(request, ct).ConfigureAwait(false),
                _ => ErrorEnvelope(request.Id, -32601, $"Method not found: '{request.Method}'."),
            };
        }
        catch (McpInvalidParamsException ex)
        {
            return ErrorEnvelope(request.Id, -32602, ex.Message);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return ErrorEnvelope(request.Id, -32000, "Timeout: tool invocation exceeded ToolInvokeTimeout.");
        }
#pragma warning disable CA1031 // Top-level dispatch intentionally converts every exception into a JSON-RPC error response.
        catch (Exception ex)
        {
            this.logger.LogError(ex, "Unhandled exception while processing MCP request '{Method}'.", request.Method);
            return ErrorEnvelope(request.Id, -32603, $"InternalError: {ex.Message}");
        }
#pragma warning restore CA1031
    }

    private static JsonNode BuildInitializeResult() => new JsonObject
    {
        ["protocolVersion"] = "2024-11-05",
        ["capabilities"] = new JsonObject { ["tools"] = new JsonObject { ["listChanged"] = true } },
        ["serverInfo"] = new JsonObject
        {
            ["name"] = "AiOrchestrator.Mcp",
            ["version"] = "1.0.0",
        },
    };

    private static JsonRpcEnvelope ResultEnvelope(object? id, JsonNode result)
    {
        JsonElement resultEl = JsonSerializer.SerializeToElement(result, typeof(JsonNode), McpJsonContext.Default);
        return new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = resultEl,
            Error = null,
            Id = id,
        };
    }

    private static JsonRpcEnvelope ErrorEnvelope(object? id, int code, string message) =>
        new()
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = null,
            Error = new JsonRpcError { Code = code, Message = message, Data = null },
            Id = id,
        };

    private async Task<JsonRpcEnvelope> InvokeToolAsync(JsonRpcEnvelope request, CancellationToken ct)
    {
        if (request.Params is not JsonElement p || p.ValueKind != JsonValueKind.Object)
        {
            throw new McpInvalidParamsException("'params' must be a JSON object.");
        }

        if (!p.TryGetProperty("name", out JsonElement nameEl) || nameEl.ValueKind != JsonValueKind.String)
        {
            throw new McpInvalidParamsException("'params.name' (tool name) is required.");
        }

        string name = nameEl.GetString()!;
        JsonElement args = p.TryGetProperty("arguments", out JsonElement a) ? a : default;

        if (!this.registry.Tools.ContainsKey(name))
        {
            return ErrorEnvelope(request.Id, -32601, $"Unknown tool: '{name}'.");
        }

        TimeSpan timeout = this.opts.CurrentValue.ToolInvokeTimeout;
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        try
        {
            JsonNode result = await this.registry.InvokeAsync(name, args, timeoutCts.Token).ConfigureAwait(false);
            return ResultEnvelope(request.Id, result);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            return ErrorEnvelope(request.Id, -32000, $"Timeout: tool '{name}' exceeded {timeout.TotalSeconds:F0}s.");
        }
    }

    private JsonNode BuildToolList()
    {
        var list = new List<JsonNode>(this.registry.Tools.Count);
        foreach (KeyValuePair<string, IMcpTool> kv in this.registry.Tools)
        {
            IMcpTool t = kv.Value;
            list.Add(new JsonObject
            {
                ["name"] = t.Name,
                ["description"] = t.Description,
                ["inputSchema"] = t.InputSchema.DeepClone(),
            });
        }

        return new JsonObject { ["tools"] = new JsonArray([.. list]) };
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            JsonRpcEnvelope? req;
            try
            {
                req = await this.transport.ReceiveAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
#pragma warning disable CA1031
            catch (Exception ex)
            {
                this.logger.LogError(ex, "Transport receive failure; terminating MCP loop.");
                return;
            }
#pragma warning restore CA1031

            if (req is null)
            {
                return;
            }

            JsonRpcEnvelope resp = await this.HandleAsync(req, ct).ConfigureAwait(false);

            // Notifications (id == null AND method != null in the original request) have no response.
            if (req.Id is null && !string.IsNullOrEmpty(req.Method))
            {
                continue;
            }

            try
            {
                await this.transport.SendAsync(resp, ct).ConfigureAwait(false);
            }
#pragma warning disable CA1031
            catch (Exception ex)
            {
                this.logger.LogError(ex, "Transport send failure; terminating MCP loop.");
                return;
            }
#pragma warning restore CA1031
        }
    }
}
