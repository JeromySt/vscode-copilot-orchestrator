// <copyright file="PlanToolInvokeCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Mcp.Tools.Plan;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

/// <summary>
/// Covers the <c>InvokeCoreAsync</c> line on 5 concrete plan tools
/// (each at 85.7% / 1 uncovered line before these tests).
/// </summary>
public sealed class PlanToolInvokeCoverageTests
{
    private static readonly JsonElement EmptyParams = JsonDocument.Parse("""{ "planId": "test-id" }""").RootElement;

    [Fact]
    public async Task FinalizeCopilotPlanTool_InvokeAsync_ReturnsStubResponse()
    {
        var tool = new FinalizeCopilotPlanTool();
        var result = await tool.InvokeAsync(EmptyParams, CancellationToken.None);
        Assert.Equal("finalize_copilot_plan", result["tool"]?.GetValue<string>());
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task CancelCopilotPlanTool_InvokeAsync_ReturnsStubResponse()
    {
        var tool = new CancelCopilotPlanTool();
        var result = await tool.InvokeAsync(EmptyParams, CancellationToken.None);
        Assert.Equal("cancel_copilot_plan", result["tool"]?.GetValue<string>());
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task DeleteCopilotPlanTool_InvokeAsync_ReturnsStubResponse()
    {
        var tool = new DeleteCopilotPlanTool();
        var result = await tool.InvokeAsync(EmptyParams, CancellationToken.None);
        Assert.Equal("delete_copilot_plan", result["tool"]?.GetValue<string>());
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task CloneCopilotPlanTool_InvokeAsync_ReturnsStubResponse()
    {
        var tool = new CloneCopilotPlanTool();
        var result = await tool.InvokeAsync(EmptyParams, CancellationToken.None);
        Assert.Equal("clone_copilot_plan", result["tool"]?.GetValue<string>());
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task ArchiveCopilotPlanTool_InvokeAsync_ReturnsStubResponse()
    {
        var tool = new ArchiveCopilotPlanTool();
        var result = await tool.InvokeAsync(EmptyParams, CancellationToken.None);
        Assert.Equal("archive_copilot_plan", result["tool"]?.GetValue<string>());
        Assert.True(result["success"]?.GetValue<bool>());
    }
}
