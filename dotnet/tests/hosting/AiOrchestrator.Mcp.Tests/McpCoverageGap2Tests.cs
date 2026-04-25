// <copyright file="McpCoverageGap2Tests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Mcp.Tools.Plan;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

/// <summary>Targeted coverage-gap tests for Mcp assembly (~5 lines).</summary>
public sealed class McpCoverageGap2Tests
{
    // ================================================================
    // PlanToolBase — ObjectSchema helper, StubResponse, properties
    // ================================================================

    [Fact]
    public async Task PlanToolBase_InvokeAsync_DelegatesToInvokeCore()
    {
        var tool = new TestTool("test-plan-tool");

        using var doc = JsonDocument.Parse("""{ "planId": "abc" }""");
        var result = await tool.InvokeAsync(doc.RootElement, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("test-plan-tool", result["tool"]?.GetValue<string>());
    }

    [Fact]
    public void PlanToolBase_Properties_AreCorrect()
    {
        var tool = new TestTool("my-tool");

        Assert.Equal("my-tool", tool.Name);
        Assert.Equal("A test tool", tool.Description);
        Assert.NotNull(tool.InputSchema);
        Assert.Equal("object", tool.InputSchema["type"]?.GetValue<string>());
    }

    [Fact]
    public async Task PlanToolBase_StubResponse_ContainsPendingDaemon()
    {
        var tool = new TestTool("stub-tool");

        using var doc = JsonDocument.Parse("""{}""");
        var result = await tool.InvokeAsync(doc.RootElement, CancellationToken.None);

        Assert.True(result["success"]?.GetValue<bool>());
        Assert.Equal("pending-daemon", result["status"]?.GetValue<string>());
    }

    // ================================================================
    // McpToolRegistry — Tools dictionary access
    // ================================================================

    [Fact]
    public void McpToolRegistry_Tools_Empty_HasNoEntries()
    {
        var registry = new McpToolRegistry([]);
        Assert.Empty(registry.Tools);
    }

    [Fact]
    public void McpToolRegistry_Tools_ContainsRegisteredTool()
    {
        var t = new TestTool("tool-a");
        var registry = new McpToolRegistry([t]);
        Assert.Single(registry.Tools);
        Assert.True(registry.Tools.ContainsKey("tool-a"));
    }

    [Fact]
    public void McpToolRegistry_DuplicateToolName_Throws()
    {
        var t1 = new TestTool("dup");
        var t2 = new TestTool("dup");
        Assert.Throws<InvalidOperationException>(() => new McpToolRegistry(new[] { t1, t2 }));
    }

    // ================================================================
    // Helpers
    // ================================================================

    private sealed class TestTool : PlanToolBase
    {
        public TestTool(string name)
            : base(name, "A test tool", ObjectSchema("planId"))
        {
        }

        protected override ValueTask<JsonNode> InvokeCoreAsync(JsonElement parameters, CancellationToken ct) =>
            this.StubResponseAsync();
    }
}
