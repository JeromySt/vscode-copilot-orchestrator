// <copyright file="McpCoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Mcp.Transports;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

/// <summary>Tests targeting uncovered branches in McpServer, JsonSchemaValidator, PlanToolBase, StdioTransport, FramingCodec.</summary>
public sealed class McpCoverageGapTests
{
    // ================================================================
    // McpServer.HandleAsync — various method dispatching
    // ================================================================

    [Fact]
    public async Task HandleAsync_Initialize_ReturnsProtocolVersion()
    {
        var server = BuildServer();

        var resp = await server.HandleAsync(Req("initialize"), CancellationToken.None);

        Assert.NotNull(resp.Result);
        Assert.Null(resp.Error);
        using var doc = JsonDocument.Parse(resp.Result!.Value.GetRawText());
        Assert.Equal("2024-11-05", doc.RootElement.GetProperty("protocolVersion").GetString());
    }

    [Fact]
    public async Task HandleAsync_ToolsList_ReturnsToolArray()
    {
        var tool = new StubTool("test-tool");
        var server = BuildServer(tool);

        var resp = await server.HandleAsync(Req("tools/list"), CancellationToken.None);

        Assert.NotNull(resp.Result);
        Assert.Null(resp.Error);
        using var doc = JsonDocument.Parse(resp.Result!.Value.GetRawText());
        Assert.True(doc.RootElement.GetProperty("tools").GetArrayLength() > 0);
    }

    [Fact]
    public async Task HandleAsync_UnknownMethod_ReturnsMethodNotFound()
    {
        var server = BuildServer();

        var resp = await server.HandleAsync(Req("nonexistent/method"), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32601, resp.Error!.Code);
        Assert.Contains("nonexistent/method", resp.Error.Message);
    }

    [Fact]
    public async Task HandleAsync_EmptyMethod_ReturnsInvalidRequest()
    {
        var server = BuildServer();

        var req = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = "",
            Params = null,
            Result = null,
            Error = null,
            Id = 1,
        };

        var resp = await server.HandleAsync(req, CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32600, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_NullMethod_ReturnsInvalidRequest()
    {
        var server = BuildServer();

        var req = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = null,
            Error = null,
            Id = 1,
        };

        var resp = await server.HandleAsync(req, CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32600, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_NullRequest_Throws()
    {
        var server = BuildServer();

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => server.HandleAsync(null!, CancellationToken.None));
    }

    // ================================================================
    // McpServer.HandleAsync — tools/call branches
    // ================================================================

    [Fact]
    public async Task HandleAsync_ToolsCall_WithValidArgs_SucceedsAndReturnsResult()
    {
        var tool = new StubTool("my-tool");
        var server = BuildServer(tool);

        using var doc = JsonDocument.Parse("""{ "name": "my-tool", "arguments": { "planId": "abc" } }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.Null(resp.Error);
        Assert.NotNull(resp.Result);
        Assert.Equal(1, tool.InvokeCount);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_UnknownToolName_Returns32601()
    {
        var server = BuildServer();

        using var doc = JsonDocument.Parse("""{ "name": "unknown-tool", "arguments": {} }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32601, resp.Error!.Code);
        Assert.Contains("unknown-tool", resp.Error.Message);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_NoParams_Returns32602()
    {
        var server = BuildServer();
        var resp = await server.HandleAsync(Req("tools/call"), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32602, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_ParamsNotObject_Returns32602()
    {
        var server = BuildServer();
        using var doc = JsonDocument.Parse("""[ "array" ]""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32602, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_MissingNameParam_Returns32602()
    {
        var server = BuildServer();
        using var doc = JsonDocument.Parse("""{ "arguments": {} }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32602, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_WithEmptyArguments_UsesDefault()
    {
        var tool = new StubTool("my-tool", requiresPlanId: false);
        var server = BuildServer(tool);

        using var doc = JsonDocument.Parse("""{ "name": "my-tool", "arguments": {} }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.Null(resp.Error);
        Assert.Equal(1, tool.InvokeCount);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_MissingArguments_PassesDefaultJsonElement()
    {
        var tool = new StubTool("my-tool", requiresPlanId: false);
        var server = BuildServer(tool);

        using var doc = JsonDocument.Parse("""{ "name": "my-tool" }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        // When arguments key is missing, the default JsonElement (Undefined) fails schema validation
        Assert.NotNull(resp.Error);
        Assert.Equal(-32602, resp.Error!.Code);
    }

    [Fact]
    public async Task HandleAsync_ToolsCall_ToolThrows_ReturnsInternalError()
    {
        var tool = new ThrowingTool();
        var server = BuildServer(tool);

        using var doc = JsonDocument.Parse("""{ "name": "throwing", "arguments": {} }""");
        var resp = await server.HandleAsync(Req("tools/call", doc.RootElement.Clone()), CancellationToken.None);

        Assert.NotNull(resp.Error);
        Assert.Equal(-32603, resp.Error!.Code);
    }

    // ================================================================
    // McpServer — lifecycle (Start/Stop/Dispose)
    // ================================================================

    [Fact]
    public async Task McpServer_StartThenStop_DoesNotThrow()
    {
        var server = BuildServer();
        await server.StartAsync(CancellationToken.None);
        await server.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task McpServer_DisposeAsync_StopsLoop()
    {
        var server = BuildServer();
        await server.StartAsync(CancellationToken.None);
        await server.DisposeAsync();
    }

    [Fact]
    public async Task McpServer_RunLoop_HandlesNotification_SkipsResponse()
    {
        // A notification has id=null and method!=null — should not generate a response
        var sentResponses = new List<JsonRpcEnvelope>();
        var transport = new SequenceTransport(
            new JsonRpcEnvelope
            {
                JsonRpc = "2.0",
                Method = "notifications/initialized",
                Params = null,
                Result = null,
                Error = null,
                Id = null, // notification
            });
        transport.Sent = sentResponses;

        var server = BuildServer(transport: transport);
        await server.StartAsync(CancellationToken.None);
        await Task.Delay(200);
        await server.StopAsync(CancellationToken.None);

        // Notifications should not produce a response
        Assert.Empty(sentResponses);
    }

    // ================================================================
    // JsonSchemaValidator — type mismatches, array, boolean, null, nested
    // ================================================================

    [Fact]
    public void JsonSchemaValidator_TypeMismatch_ReportsError()
    {
        var schema = JsonNode.Parse("""{ "type": "string" }""")!;
        using var doc = JsonDocument.Parse("42");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.NotEmpty(errors);
        Assert.Contains("expected type 'string'", errors[0]);
    }

    [Fact]
    public void JsonSchemaValidator_RequiredPropertyMissing_ReportsError()
    {
        var schema = JsonNode.Parse("""
        {
            "type": "object",
            "required": ["name"],
            "properties": { "name": { "type": "string" } }
        }
        """)!;
        using var doc = JsonDocument.Parse("{}");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.NotEmpty(errors);
        Assert.Contains("missing required property 'name'", errors[0]);
    }

    [Fact]
    public void JsonSchemaValidator_ArrayItems_ValidatesEach()
    {
        var schema = JsonNode.Parse("""
        {
            "type": "array",
            "items": { "type": "string" }
        }
        """)!;
        using var doc = JsonDocument.Parse("""["hello", 42]""");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Single(errors);
        Assert.Contains("$[1]", errors[0]);
    }

    [Fact]
    public void JsonSchemaValidator_BooleanType_Matches()
    {
        var schema = JsonNode.Parse("""{ "type": "boolean" }""")!;
        using var doc = JsonDocument.Parse("true");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Empty(errors);
    }

    [Fact]
    public void JsonSchemaValidator_NullType_Matches()
    {
        var schema = JsonNode.Parse("""{ "type": "null" }""")!;
        using var doc = JsonDocument.Parse("null");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Empty(errors);
    }

    [Fact]
    public void JsonSchemaValidator_IntegerType_ValidatesCorrectly()
    {
        var schema = JsonNode.Parse("""{ "type": "integer" }""")!;

        using var intDoc = JsonDocument.Parse("42");
        Assert.Empty(JsonSchemaValidator.Validate(schema, intDoc.RootElement));

        using var floatDoc = JsonDocument.Parse("3.14");
        Assert.NotEmpty(JsonSchemaValidator.Validate(schema, floatDoc.RootElement));
    }

    [Fact]
    public void JsonSchemaValidator_NumberType_AcceptsFloats()
    {
        var schema = JsonNode.Parse("""{ "type": "number" }""")!;
        using var doc = JsonDocument.Parse("3.14");
        Assert.Empty(JsonSchemaValidator.Validate(schema, doc.RootElement));
    }

    [Fact]
    public void JsonSchemaValidator_NestedObjectValidation()
    {
        var schema = JsonNode.Parse("""
        {
            "type": "object",
            "properties": {
                "inner": {
                    "type": "object",
                    "required": ["id"],
                    "properties": { "id": { "type": "string" } }
                }
            }
        }
        """)!;
        using var doc = JsonDocument.Parse("""{ "inner": {} }""");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Single(errors);
        Assert.Contains("$.inner", errors[0]);
    }

    [Fact]
    public void JsonSchemaValidator_UnknownType_PassesValidation()
    {
        var schema = JsonNode.Parse("""{ "type": "custom-type" }""")!;
        using var doc = JsonDocument.Parse("42");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Empty(errors);
    }

    [Fact]
    public void JsonSchemaValidator_NullSchema_ReturnsNoErrors()
    {
        using var doc = JsonDocument.Parse("42");
        var errors = JsonSchemaValidator.Validate(null!, doc.RootElement);
        Assert.Empty(errors);
    }

    [Fact]
    public void JsonSchemaValidator_ValidObject_ReturnsNoErrors()
    {
        var schema = JsonNode.Parse("""
        {
            "type": "object",
            "required": ["name"],
            "properties": { "name": { "type": "string" } }
        }
        """)!;
        using var doc = JsonDocument.Parse("""{ "name": "test" }""");
        var errors = JsonSchemaValidator.Validate(schema, doc.RootElement);
        Assert.Empty(errors);
    }

    // ================================================================
    // StdioTransport — ReadHeaders edge cases, Dispose
    // ================================================================

    [Fact]
    public async Task StdioTransport_ReadHeadersAsync_EmptyStream_ReturnsNull()
    {
        using var stream = new MemoryStream(Array.Empty<byte>());
        var result = await StdioTransport.ReadHeadersAsync(stream, CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task StdioTransport_ReadHeadersAsync_NoContentLength_ReturnsNull()
    {
        var data = Encoding.UTF8.GetBytes("X-Custom: value\r\n\r\n");
        using var stream = new MemoryStream(data);
        var result = await StdioTransport.ReadHeadersAsync(stream, CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task StdioTransport_ReadHeadersAsync_ValidContentLength_ReturnsValue()
    {
        var data = Encoding.UTF8.GetBytes("Content-Length: 42\r\n\r\n");
        using var stream = new MemoryStream(data);
        var result = await StdioTransport.ReadHeadersAsync(stream, CancellationToken.None);
        Assert.Equal(42, result);
    }

    [Fact]
    public async Task StdioTransport_ReceiveAsync_IncompleteBody_ReturnsNull()
    {
        var header = Encoding.UTF8.GetBytes("Content-Length: 999\r\n\r\n");
        // Only provide 5 body bytes when 999 are expected
        var combined = new byte[header.Length + 5];
        header.CopyTo(combined, 0);
        using var stream = new MemoryStream(combined);
        using var transport = new StdioTransport(stream, Stream.Null, ownsStreams: false);

        var result = await transport.ReceiveAsync(CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task StdioTransport_SendAndReceive_Roundtrip()
    {
        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = "test/method",
            Params = null,
            Result = null,
            Error = null,
            Id = 99,
        };

        using var ms = new MemoryStream();
        using (var writer = new StdioTransport(Stream.Null, ms, ownsStreams: false))
        {
            await writer.SendAsync(envelope, CancellationToken.None);
        }

        ms.Position = 0;
        using var reader = new StdioTransport(ms, Stream.Null, ownsStreams: false);
        var parsed = await reader.ReceiveAsync(CancellationToken.None);

        Assert.NotNull(parsed);
        Assert.Equal("test/method", parsed!.Method);
        Assert.Equal("2.0", parsed.JsonRpc);
    }

    [Fact]
    public void StdioTransport_Dispose_WithOwnsStreams_DisposesStreams()
    {
        var input = new MemoryStream();
        var output = new MemoryStream();
        var transport = new StdioTransport(input, output, ownsStreams: true);
        transport.Dispose();

        // Accessing disposed streams should throw
        Assert.Throws<ObjectDisposedException>(() => input.ReadByte());
        Assert.Throws<ObjectDisposedException>(() => output.WriteByte(0));
    }

    [Fact]
    public void StdioTransport_Dispose_WithoutOwnsStreams_KeepsStreamsOpen()
    {
        var input = new MemoryStream();
        var output = new MemoryStream();
        var transport = new StdioTransport(input, output, ownsStreams: false);
        transport.Dispose();

        // Streams should still be accessible
        input.Position = 0;
        output.WriteByte(0);
    }

    [Fact]
    public void StdioTransport_Constructor_NullInput_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new StdioTransport(null!, Stream.Null));
    }

    [Fact]
    public void StdioTransport_Constructor_NullOutput_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new StdioTransport(Stream.Null, null!));
    }

    // ================================================================
    // FramingCodec — error encoding, null id, Decode null
    // ================================================================

    [Fact]
    public void FramingCodec_Encode_WithError_Roundtrips()
    {
        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = null,
            Error = new JsonRpcError { Code = -32600, Message = "Invalid Request", Data = null },
            Id = 1,
        };

        var bytes = FramingCodec.Encode(envelope);
        var decoded = FramingCodec.Decode(bytes);

        Assert.NotNull(decoded);
        Assert.NotNull(decoded!.Error);
        Assert.Equal(-32600, decoded.Error!.Code);
        Assert.Equal("Invalid Request", decoded.Error.Message);
    }

    [Fact]
    public void FramingCodec_Encode_WithResult_Roundtrips()
    {
        var resultNode = new JsonObject { ["success"] = true };
        var resultEl = JsonSerializer.SerializeToElement(resultNode);

        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = resultEl,
            Error = null,
            Id = 42,
        };

        var bytes = FramingCodec.Encode(envelope);
        var decoded = FramingCodec.Decode(bytes);

        Assert.NotNull(decoded);
        Assert.NotNull(decoded!.Result);
        Assert.Null(decoded.Error);
    }

    [Fact]
    public void FramingCodec_Encode_NullId_Roundtrips()
    {
        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = "notify",
            Params = null,
            Result = null,
            Error = null,
            Id = null,
        };

        var bytes = FramingCodec.Encode(envelope);
        var decoded = FramingCodec.Decode(bytes);

        Assert.NotNull(decoded);
        Assert.Null(decoded!.Id);
        Assert.Equal("notify", decoded.Method);
    }

    [Fact]
    public void FramingCodec_Decode_EmptySpan_Throws()
    {
        Assert.ThrowsAny<JsonException>(() => FramingCodec.Decode(ReadOnlySpan<byte>.Empty));
    }

    // ================================================================
    // McpServer constructor validation
    // ================================================================

    [Fact]
    public void McpServer_Constructor_NullRegistry_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new McpServer(
            null!,
            new FakeTransport(),
            new StaticOptionsMonitor<McpOptions>(new McpOptions()),
            NullLogger<McpServer>.Instance));
    }

    [Fact]
    public void McpServer_Constructor_NullTransport_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new McpServer(
            new McpToolRegistry([]),
            null!,
            new StaticOptionsMonitor<McpOptions>(new McpOptions()),
            NullLogger<McpServer>.Instance));
    }

    // ================================================================
    // Helpers
    // ================================================================

    private static McpServer BuildServer(params IMcpTool[] tools)
    {
        var registry = new McpToolRegistry(tools);
        return new McpServer(
            registry,
            new FakeTransport(),
            new StaticOptionsMonitor<McpOptions>(new McpOptions()),
            NullLogger<McpServer>.Instance);
    }

    private static McpServer BuildServer(IMcpTransport transport, params IMcpTool[] tools)
    {
        var registry = new McpToolRegistry(tools);
        return new McpServer(
            registry,
            transport,
            new StaticOptionsMonitor<McpOptions>(new McpOptions()),
            NullLogger<McpServer>.Instance);
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

    private sealed class StubTool : IMcpTool
    {
        private readonly bool requiresPlanId;

        public StubTool(string name, bool requiresPlanId = true)
        {
            this.Name = name;
            this.requiresPlanId = requiresPlanId;
        }

        public string Name { get; }

        public string Description => "Stub tool for testing";

        public JsonNode InputSchema => this.requiresPlanId
            ? new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject { ["planId"] = new JsonObject { ["type"] = "string" } },
                ["required"] = new JsonArray("planId"),
            }
            : new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject(),
            };

        public int InvokeCount { get; private set; }

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            this.InvokeCount++;
            return ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
        }
    }

    private sealed class ThrowingTool : IMcpTool
    {
        public string Name => "throwing";

        public string Description => "Always throws";

        public JsonNode InputSchema => new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject(),
        };

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
            => throw new InvalidOperationException("tool exploded");
    }

    private sealed class FakeTransport : IMcpTransport
    {
        public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct) =>
            ValueTask.FromResult<JsonRpcEnvelope?>(null);

        public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct) =>
            ValueTask.CompletedTask;
    }

    private sealed class SequenceTransport : IMcpTransport
    {
        private readonly Queue<JsonRpcEnvelope> queue = new();
        public List<JsonRpcEnvelope>? Sent { get; set; }

        public SequenceTransport(params JsonRpcEnvelope[] requests)
        {
            foreach (var r in requests)
                this.queue.Enqueue(r);
        }

        public ValueTask<JsonRpcEnvelope?> ReceiveAsync(CancellationToken ct)
        {
            if (this.queue.Count > 0)
                return ValueTask.FromResult<JsonRpcEnvelope?>(this.queue.Dequeue());
            return ValueTask.FromResult<JsonRpcEnvelope?>(null);
        }

        public ValueTask SendAsync(JsonRpcEnvelope envelope, CancellationToken ct)
        {
            this.Sent?.Add(envelope);
            return ValueTask.CompletedTask;
        }
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
