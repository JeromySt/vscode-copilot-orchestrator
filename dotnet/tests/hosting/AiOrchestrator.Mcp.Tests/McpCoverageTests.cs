// <copyright file="McpCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

/// <summary>Coverage tests for MCP types: options, DTOs, enums, registry, and schema validator.</summary>
public sealed class McpCoverageTests
{
    // ---- McpOptions ---------------------------------------------------------

    [Fact]
    public void McpOptions_DefaultTransport_IsStdio()
    {
        var opts = new McpOptions();
        Assert.Equal(McpTransportKind.Stdio, opts.Transport);
    }

    [Fact]
    public void McpOptions_DefaultToolInvokeTimeout_Is60Seconds()
    {
        var opts = new McpOptions();
        Assert.Equal(TimeSpan.FromSeconds(60), opts.ToolInvokeTimeout);
    }

    [Fact]
    public void McpOptions_WithInit_OverridesDefaults()
    {
        var opts = new McpOptions
        {
            Transport = McpTransportKind.NamedPipe,
            ToolInvokeTimeout = TimeSpan.FromSeconds(120),
        };
        Assert.Equal(McpTransportKind.NamedPipe, opts.Transport);
        Assert.Equal(TimeSpan.FromSeconds(120), opts.ToolInvokeTimeout);
    }

    // ---- McpTransportKind enum ----------------------------------------------

    [Theory]
    [InlineData(McpTransportKind.Stdio, 0)]
    [InlineData(McpTransportKind.NamedPipe, 1)]
    [InlineData(McpTransportKind.UnixSocket, 2)]
    public void McpTransportKind_HasExpectedValues(McpTransportKind kind, int expected)
    {
        Assert.Equal(expected, (int)kind);
    }

    // ---- JsonRpcEnvelope ----------------------------------------------------

    [Fact]
    public void JsonRpcEnvelope_CanConstructRequest()
    {
        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = "tools/list",
            Params = null,
            Result = null,
            Error = null,
            Id = 1,
        };

        Assert.Equal("2.0", envelope.JsonRpc);
        Assert.Equal("tools/list", envelope.Method);
        Assert.Null(envelope.Params);
        Assert.Null(envelope.Result);
        Assert.Null(envelope.Error);
        Assert.Equal(1, envelope.Id);
    }

    [Fact]
    public void JsonRpcEnvelope_CanConstructErrorResponse()
    {
        var error = new JsonRpcError
        {
            Code = -32600,
            Message = "Invalid Request",
            Data = null,
        };

        var envelope = new JsonRpcEnvelope
        {
            JsonRpc = "2.0",
            Method = null,
            Params = null,
            Result = null,
            Error = error,
            Id = 42,
        };

        Assert.Null(envelope.Method);
        Assert.NotNull(envelope.Error);
        Assert.Equal(-32600, envelope.Error!.Code);
    }

    // ---- JsonRpcError -------------------------------------------------------

    [Fact]
    public void JsonRpcError_CanConstruct()
    {
        var error = new JsonRpcError
        {
            Code = -32601,
            Message = "Method not found",
            Data = null,
        };

        Assert.Equal(-32601, error.Code);
        Assert.Equal("Method not found", error.Message);
        Assert.Null(error.Data);
    }

    [Fact]
    public void JsonRpcError_WithData()
    {
        using var doc = JsonDocument.Parse("{\"detail\":\"extra\"}");
        var error = new JsonRpcError
        {
            Code = -32000,
            Message = "Server error",
            Data = doc.RootElement.Clone(),
        };

        Assert.NotNull(error.Data);
        Assert.Equal(JsonValueKind.Object, error.Data!.Value.ValueKind);
    }

    // ---- McpInvalidParamsException -------------------------------------------

    [Fact]
    public void McpInvalidParamsException_DefaultCtor()
    {
        var ex = new McpInvalidParamsException();
        Assert.NotNull(ex.Message);
    }

    [Fact]
    public void McpInvalidParamsException_MessageCtor()
    {
        var ex = new McpInvalidParamsException("bad params");
        Assert.Equal("bad params", ex.Message);
    }

    [Fact]
    public void McpInvalidParamsException_InnerExceptionCtor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new McpInvalidParamsException("outer", inner);
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    // ---- McpToolRegistry ----------------------------------------------------

    [Fact]
    public void McpToolRegistry_NullTools_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new McpToolRegistry(null!));
    }

    [Fact]
    public void McpToolRegistry_EmptyTools_CreatesEmptyRegistry()
    {
        var registry = new McpToolRegistry([]);
        Assert.Empty(registry.Tools);
    }

    [Fact]
    public void McpToolRegistry_DuplicateName_Throws()
    {
        var tool1 = new FakeTool("dupe");
        var tool2 = new FakeTool("dupe");
        Assert.Throws<InvalidOperationException>(() => new McpToolRegistry([tool1, tool2]));
    }

    [Fact]
    public void McpToolRegistry_SingleTool_IsRegistered()
    {
        var tool = new FakeTool("my-tool");
        var registry = new McpToolRegistry([tool]);

        Assert.Single(registry.Tools);
        Assert.True(registry.Tools.ContainsKey("my-tool"));
    }

    [Fact]
    public async Task McpToolRegistry_InvokeAsync_UnknownTool_ThrowsKeyNotFound()
    {
        var registry = new McpToolRegistry([]);
        using var doc = JsonDocument.Parse("{}");

        await Assert.ThrowsAsync<KeyNotFoundException>(() =>
            registry.InvokeAsync("nonexistent", doc.RootElement.Clone(), CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task McpToolRegistry_InvokeAsync_ValidParams_CallsTool()
    {
        var tool = new FakeTool("echo");
        var registry = new McpToolRegistry([tool]);

        using var doc = JsonDocument.Parse("{\"planId\":\"abc\"}");
        var result = await registry.InvokeAsync("echo", doc.RootElement.Clone(), CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(1, tool.InvokeCount);
    }

    [Fact]
    public async Task McpToolRegistry_InvokeAsync_MissingRequiredParam_ThrowsInvalidParams()
    {
        var tool = new FakeTool("echo");
        var registry = new McpToolRegistry([tool]);

        using var doc = JsonDocument.Parse("{\"other\":\"x\"}");
        await Assert.ThrowsAsync<McpInvalidParamsException>(() =>
            registry.InvokeAsync("echo", doc.RootElement.Clone(), CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task McpToolRegistry_InvokeAsync_NullToolName_Throws()
    {
        var registry = new McpToolRegistry([]);
        using var doc = JsonDocument.Parse("{}");

        await Assert.ThrowsAsync<ArgumentNullException>(() =>
            registry.InvokeAsync(null!, doc.RootElement.Clone(), CancellationToken.None).AsTask());
    }

    // ---- Helper classes ---------------------------------------------------

    private sealed class FakeTool : IMcpTool
    {
        public FakeTool(string name) => this.Name = name;

        public string Name { get; }

        public string Description => "Fake tool for testing";

        public JsonNode InputSchema { get; } = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["planId"] = new JsonObject { ["type"] = "string" },
            },
            ["required"] = new JsonArray("planId"),
        };

        public int InvokeCount { get; private set; }

        public ValueTask<JsonNode> InvokeAsync(JsonElement parameters, CancellationToken ct)
        {
            this.InvokeCount++;
            return ValueTask.FromResult<JsonNode>(new JsonObject { ["ok"] = true });
        }
    }
}
