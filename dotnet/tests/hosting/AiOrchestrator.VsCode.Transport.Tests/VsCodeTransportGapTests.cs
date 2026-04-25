// <copyright file="VsCodeTransportGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Bindings.Node;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
using AiOrchestrator.VsCode.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.VsCode.Transport.Tests;

/// <summary>Gap-filling tests for VsCodeTransport and TransportSession.</summary>
public sealed class VsCodeTransportGapTests
{
    // ---- VsCodeTransport.DisposeAsync ----

    [Fact]
    public async Task DisposeAsync_IsIdempotent()
    {
        await using VsCodeTransport transport = Build(out _, out _);

        await transport.DisposeAsync();
        // Second call should not throw.
        await transport.DisposeAsync();
    }

    [Fact]
    public async Task CreateSessionAsync_AfterDispose_Throws()
    {
        VsCodeTransport transport = Build(out _, out _);
        await transport.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => transport.CreateSessionAsync(new VsCodeWindowId("w"), CancellationToken.None).AsTask());
    }

    // ---- TransportSession ----

    [Fact]
    public async Task InvokeToolAsync_AfterDispose_Throws()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("inv-disp"), CancellationToken.None);
        await session.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => session.InvokeToolAsync("some-tool", Json("{}"), CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task InvokeToolAsync_UnknownTool_ReturnsErrorEnvelope()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("err"), CancellationToken.None);

        JsonNode result = await session.InvokeToolAsync("nonexistent-tool", Json("{}"), CancellationToken.None);

        Assert.NotNull(result["error"]);
        Assert.NotNull(result["error"]!["code"]);
        Assert.NotNull(result["error"]!["message"]);
    }

    [Fact]
    public async Task Publish_AfterDispose_ReturnsFalse()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("pub-disp"), CancellationToken.None);
        await session.DisposeAsync();

        bool result = session.Publish(new TransportEvent
        {
            Kind = "test",
            Payload = Json("{\"x\":1}"),
            At = DateTimeOffset.UtcNow,
        });

        Assert.False(result);
    }

    [Fact]
    public async Task DisposeAsync_Session_IsIdempotent()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("idem"), CancellationToken.None);

        await session.DisposeAsync();
        await session.DisposeAsync(); // No throw expected.

        Assert.True(session.IsDisposed);
    }

    [Fact]
    public async Task CreateSessionAsync_SameWindowId_ReplacesExistingSession()
    {
        await using VsCodeTransport transport = Build(out _, out _);

        TransportSession s1 = await transport.CreateSessionAsync(new VsCodeWindowId("dup"), CancellationToken.None);
        TransportSession s2 = await transport.CreateSessionAsync(new VsCodeWindowId("dup"), CancellationToken.None);

        Assert.NotSame(s1, s2);
        Assert.False(s2.IsDisposed);
    }

    [Fact]
    public async Task WatchEventsAsync_AfterDispose_CompletesImmediately()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("watch-disp"), CancellationToken.None);

        session.Publish(new TransportEvent { Kind = "test", Payload = Json("{\"a\":1}"), At = DateTimeOffset.UtcNow });
        await session.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
        {
            await foreach (var _ in session.WatchEventsAsync(CancellationToken.None))
            {
            }
        });
    }

    [Fact]
    public async Task Publish_NullEvent_Throws()
    {
        await using VsCodeTransport transport = Build(out _, out _);
        await using TransportSession session = await transport.CreateSessionAsync(new VsCodeWindowId("null-evt"), CancellationToken.None);

        Assert.Throws<ArgumentNullException>(() => session.Publish(null!));
    }

    // ---- Helpers ----

    private static VsCodeTransport Build(
        out NodeBindingsHost bindings,
        out McpServer mcp,
        IClock? clock = null,
        TransportOptions? opts = null)
    {
        clock ??= new GapSystemClock();
        opts ??= new TransportOptions();

        var services = new ServiceCollection();
        _ = services.AddLogging();
        _ = services.AddSingleton<IMcpTransport>(_ => new GapNullTransport());
        _ = services.AddSingleton<McpToolRegistry>(sp =>
        {
            List<IMcpTool> tools = [new GapNoopTool()];
            return new McpToolRegistry(tools);
        });
        _ = services.Configure<McpOptions>(_ => { });
        _ = services.AddSingleton<McpServer>();

        ServiceProvider sp = services.BuildServiceProvider();
        bindings = new NodeBindingsHost(sp);
        mcp = sp.GetRequiredService<McpServer>();

        var transportOpts = new GapStaticMonitor<TransportOptions>(opts);
        return new VsCodeTransport(bindings, mcp, clock, transportOpts, NullLogger<VsCodeTransport>.Instance);
    }

    private static JsonElement Json(string raw)
    {
        using JsonDocument doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }

    private sealed class GapNullTransport : IMcpTransport
    {
        public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) => ValueTask.FromResult<JsonRpcEnvelope?>(null);

        public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) => ValueTask.CompletedTask;
    }

    private sealed class GapNoopTool : IMcpTool
    {
        public string Name => "noop";

        public string Description => "noop";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct) =>
            ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
    }

    private sealed class GapSystemClock : IClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public long MonotonicMilliseconds => Environment.TickCount64;
    }

    private sealed class GapStaticMonitor<T> : IOptionsMonitor<T>
        where T : class
    {
        public GapStaticMonitor(T value) => this.CurrentValue = value;

        public T CurrentValue { get; }

        public T Get(string? name) => this.CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
