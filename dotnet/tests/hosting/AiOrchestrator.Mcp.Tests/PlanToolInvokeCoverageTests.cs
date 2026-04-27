// <copyright file="PlanToolInvokeCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Mcp.Tools.Plan;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store;
using Xunit;

namespace AiOrchestrator.Mcp.Tests;

/// <summary>
/// Covers the <c>InvokeCoreAsync</c> line on 5 concrete plan tools wired to a fake <see cref="IPlanStore"/>.
/// </summary>
public sealed class PlanToolInvokeCoverageTests
{
    private static readonly PlanId TestPlanId = PlanId.New();

    private static JsonElement MakeParams() =>
        JsonDocument.Parse($$"""{ "planId": "{{TestPlanId}}", "repo_root": "C:\\fake-repo" }""").RootElement;

    private static FakePlanStoreFactory FactoryWithPlan() => new(new AiOrchestrator.Plan.Models.Plan
    {
        Id = TestPlanId.ToString(),
        Name = "Test Plan",
        Status = PlanStatus.Running,
        CreatedAt = DateTimeOffset.UtcNow,
        Jobs = new Dictionary<string, JobNode>
        {
            ["job-1"] = new JobNode { Id = "job-1", Title = "Job 1", Status = JobStatus.Pending },
        },
    });

    [Fact]
    public async Task FinalizeCopilotPlanTool_InvokeAsync_ReturnsSuccess()
    {
        var tool = new FinalizeCopilotPlanTool(FactoryWithPlan());
        var result = await tool.InvokeAsync(MakeParams(), CancellationToken.None);
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task CancelCopilotPlanTool_InvokeAsync_ReturnsSuccess()
    {
        var tool = new CancelCopilotPlanTool(FactoryWithPlan());
        var result = await tool.InvokeAsync(MakeParams(), CancellationToken.None);
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task DeleteCopilotPlanTool_InvokeAsync_ReturnsSuccess()
    {
        var tool = new DeleteCopilotPlanTool(FactoryWithPlan());
        var result = await tool.InvokeAsync(MakeParams(), CancellationToken.None);
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task CloneCopilotPlanTool_InvokeAsync_ReturnsSuccess()
    {
        var tool = new CloneCopilotPlanTool(FactoryWithPlan());
        var result = await tool.InvokeAsync(MakeParams(), CancellationToken.None);
        Assert.True(result["success"]?.GetValue<bool>());
    }

    [Fact]
    public async Task ArchiveCopilotPlanTool_InvokeAsync_ReturnsSuccess()
    {
        var tool = new ArchiveCopilotPlanTool(FactoryWithPlan());
        var result = await tool.InvokeAsync(MakeParams(), CancellationToken.None);
        Assert.True(result["success"]?.GetValue<bool>());
    }

    /// <summary>Wraps a <see cref="FakePlanStore"/> as a factory for test use.</summary>
    internal sealed class FakePlanStoreFactory : IPlanStoreFactory
    {
        private readonly FakePlanStore store;

        public FakePlanStoreFactory() => this.store = new FakePlanStore();

        public FakePlanStoreFactory(AiOrchestrator.Plan.Models.Plan seed) => this.store = new FakePlanStore(seed);

        public IPlanStore GetStore(string repoRoot) => this.store;
    }

    /// <summary>Minimal in-memory <see cref="IPlanStore"/> for unit tests.</summary>
    internal sealed class FakePlanStore : IPlanStore
    {
        private readonly Dictionary<PlanId, AiOrchestrator.Plan.Models.Plan> plans = new();
        private int seq;

        public FakePlanStore() { }

        public FakePlanStore(AiOrchestrator.Plan.Models.Plan seed)
        {
            var id = PlanId.TryParse(seed.Id, out var pid) ? pid : PlanId.New();
            this.plans[id] = seed;
        }

        public ValueTask<PlanId> CreateAsync(AiOrchestrator.Plan.Models.Plan initialPlan, IdempotencyKey idemKey, CancellationToken ct)
        {
            var id = PlanId.New();
            this.plans[id] = initialPlan with { Id = id.ToString() };
            return ValueTask.FromResult(id);
        }

        public ValueTask<AiOrchestrator.Plan.Models.Plan?> LoadAsync(PlanId id, CancellationToken ct) =>
            ValueTask.FromResult(this.plans.TryGetValue(id, out var p) ? p : null);

        public ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct) =>
            ValueTask.CompletedTask;

        public ValueTask CheckpointAsync(PlanId id, CancellationToken ct) =>
            ValueTask.CompletedTask;

        public async IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> ListAsync([EnumeratorCancellation] CancellationToken ct)
        {
            foreach (var p in this.plans.Values)
            {
                yield return p;
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }

        public async IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            yield break;
        }

        public async IAsyncEnumerable<AiOrchestrator.Plan.Models.Plan> WatchAsync(PlanId id, [EnumeratorCancellation] CancellationToken ct)
        {
            if (this.plans.TryGetValue(id, out var p))
            {
                yield return p;
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }
}
