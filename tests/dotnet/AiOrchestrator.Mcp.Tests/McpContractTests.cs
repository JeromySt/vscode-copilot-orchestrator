// <copyright file="McpContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Composition;
using AiOrchestrator.Mcp;
using AiOrchestrator.Mcp.Transports;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class McpContractTests
{
    private static McpServer BuildServer(McpToolRegistry registry, IMcpTransport transport, TimeSpan? timeout = null)
    {
        var monitor = new StaticOptionsMonitor<McpOptions>(new McpOptions
        {
            ToolInvokeTimeout = timeout ?? TimeSpan.FromSeconds(60),
        });

        return new McpServer(registry, transport, monitor, NullLogger<McpServer>.Instance);
    }

    private static JsonRpcEnvelope Req(string method, JsonElement? @params = null, int id = 1) =>
        new()
        {
            JsonRpc = "2.0",
            Method = method,
            Params = @params,
            Result = null,
            Error = null,
            Id = id,
        };

    // -------------------------------------------------------------------------
    // MCP-FRAME: Bad envelope (wrong jsonrpc version) rejected with -32600
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-FRAME")]
    public async Task MCP_RPC_FrameValidationRejectsBadEnvelope()
    {
        var registry = new McpToolRegistry([new EchoTool()]);
        var transport = new FakeTransport();
        McpServer server = BuildServer(registry, transport);

        var badRequest = new JsonRpcEnvelope
        {
            JsonRpc = "1.0", // WRONG
            Method = "tools/list",
            Params = null,
            Result = null,
            Error = null,
            Id = 42,
        };

        JsonRpcEnvelope resp = await server.HandleAsync(badRequest, CancellationToken.None);

        resp.Error.Should().NotBeNull();
        resp.Error!.Code.Should().Be(-32600);
        resp.Result.Should().BeNull();
    }

    // -------------------------------------------------------------------------
    // MCP-INPUT: Input schema validated before tool invocation (-32602)
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-INPUT")]
    public async Task MCP_TOOL_InputSchemaValidatedBeforeInvoke()
    {
        var tool = new EchoTool();
        var registry = new McpToolRegistry([tool]);
        McpServer server = BuildServer(registry, new FakeTransport());

        // 'required' field missing: schema requires "planId".
        using JsonDocument doc = JsonDocument.Parse(
            $$"""
            { "name": "{{tool.Name}}", "arguments": { "other": "x" } }
            """);
        JsonRpcEnvelope req = Req("tools/call", doc.RootElement.Clone());

        JsonRpcEnvelope resp = await server.HandleAsync(req, CancellationToken.None);

        resp.Error.Should().NotBeNull();
        resp.Error!.Code.Should().Be(-32602);
        tool.Invocations.Should().Be(0, because: "validation must reject the call before Invoke runs");
    }

    // -------------------------------------------------------------------------
    // MCP-DUP: Duplicate tool name rejected at registry construction
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-DUP")]
    public void MCP_TOOL_DuplicateNameRejected()
    {
        Action act = () => _ = new McpToolRegistry([new EchoTool(), new EchoTool()]);

        act.Should().Throw<InvalidOperationException>()
            .WithMessage("*Duplicate*");
    }

    // -------------------------------------------------------------------------
    // MCP-TIMEOUT: Tool that exceeds ToolInvokeTimeout returns -32000
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-TIMEOUT")]
    public async Task MCP_TOOL_TimeoutReturns32000()
    {
        var slow = new SlowTool(TimeSpan.FromSeconds(5));
        var registry = new McpToolRegistry([slow]);
        McpServer server = BuildServer(registry, new FakeTransport(), timeout: TimeSpan.FromMilliseconds(50));

        using JsonDocument doc = JsonDocument.Parse(
            $$"""{ "name": "{{slow.Name}}", "arguments": { "planId": "p1" } }""");
        JsonRpcEnvelope req = Req("tools/call", doc.RootElement.Clone());

        JsonRpcEnvelope resp = await server.HandleAsync(req, CancellationToken.None);

        resp.Error.Should().NotBeNull();
        resp.Error!.Code.Should().Be(-32000);
    }

    // -------------------------------------------------------------------------
    // MCP-NAMES: Registered tool names match the TypeScript canonical surface
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-NAMES")]
    public void MCP_TOOL_NamesMatchTypescriptSurface()
    {
        string fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "canonical-tool-names.txt");
        File.Exists(fixturePath).Should().BeTrue(because: "canonical names fixture must be copied to output");

        HashSet<string> canonical = new(
            File.ReadAllLines(fixturePath)
                .Select(l => l.Trim())
                .Where(l => !string.IsNullOrWhiteSpace(l) && !l.StartsWith('#')),
            StringComparer.Ordinal);

        using ServiceProvider sp = BuildMcpServiceProvider();
        McpToolRegistry registry = sp.GetRequiredService<McpToolRegistry>();
        HashSet<string> registered = new(registry.Tools.Keys, StringComparer.Ordinal);

        var missing = canonical.Except(registered).ToList();
        var extra = registered.Except(canonical).ToList();

        missing.Should().BeEmpty(because: $"missing canonical tools: {string.Join(", ", missing)}");
        extra.Should().BeEmpty(because: $"extra tools not in canonical surface: {string.Join(", ", extra)}");
    }

    // -------------------------------------------------------------------------
    // MCP-STDIO: Content-Length framing per spec (roundtrip via StdioTransport)
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-STDIO")]
    public async Task MCP_STDIO_FramingPerSpec()
    {
        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = "tools/list",
            Params = null,
            Result = null,
            Error = null,
            Id = 7,
        };

        using var sendStream = new MemoryStream();
        using (var writer = new StdioTransport(Stream.Null, sendStream, ownsStreams: false))
        {
            await writer.SendAsync(envelope, CancellationToken.None);
        }

        string wire = Encoding.UTF8.GetString(sendStream.ToArray());
        wire.Should().StartWith("Content-Length: ", because: "MCP stdio framing must prefix each envelope with Content-Length");
        wire.Should().Contain("\r\n\r\n", because: "header block must be terminated by CRLFCRLF");

        // Round-trip: read back through the transport.
        using var recvStream = new MemoryStream(sendStream.ToArray());
        using var reader = new StdioTransport(recvStream, Stream.Null, ownsStreams: false);
        JsonRpcEnvelope? parsed = await reader.ReceiveAsync(CancellationToken.None);
        parsed.Should().NotBeNull();
        parsed!.Method.Should().Be("tools/list");
        parsed.JsonRpc.Should().Be("2.0");
    }

    // -------------------------------------------------------------------------
    // MCP-TOOLS-ALL: All 18 tools are registered by the composition extension
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("MCP-TOOLS-ALL")]
    public void MCP_TOOLS_ALL_18_REGISTERED()
    {
        using ServiceProvider sp = BuildMcpServiceProvider();
        McpToolRegistry registry = sp.GetRequiredService<McpToolRegistry>();

        registry.Tools.Count.Should().Be(18, because: "the MCP surface must expose exactly 18 plan/job tools");
    }

    private static ServiceProvider BuildMcpServiceProvider()
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection([])
            .Build();

        var services = new ServiceCollection();
        _ = services.AddLogging();
        _ = services.AddMcpServer(config);

        return services.BuildServiceProvider();
    }

    // ---- Test doubles ---------------------------------------------------

    private sealed class EchoTool : IMcpTool
    {
        public string Name => "echo";

        public string Description => "echoes parameters back";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["planId"] = new JsonObject { ["type"] = "string" },
            },
            ["required"] = new JsonArray("planId"),
        };

        public int Invocations { get; private set; }

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            this.Invocations++;
            return ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
        }
    }

    private sealed class SlowTool : IMcpTool
    {
        private readonly TimeSpan delay;

        public SlowTool(TimeSpan delay) => this.delay = delay;

        public string Name => "slow";

        public string Description => "sleeps";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
            ["required"] = new JsonArray("planId"),
        };

        public async ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            await Task.Delay(this.delay, ct);
            return new JsonObject { ["ok"] = true };
        }
    }

    private sealed class FakeTransport : IMcpTransport
    {
        public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) => ValueTask.FromResult<JsonRpcEnvelope?>(null);

        public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) => ValueTask.CompletedTask;
    }

    private sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
        where T : class
    {
        public StaticOptionsMonitor(T value) => this.CurrentValue = value;

        public T CurrentValue { get; }

        public T Get(string? name) => this.CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
