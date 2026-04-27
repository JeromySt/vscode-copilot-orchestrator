// <copyright file="TsPlanMigratorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.Store.Migration;
using Microsoft.Extensions.Logging.Abstractions;
using PlanStoreTestsNs;
using Xunit;

namespace AiOrchestrator.Plan.Store.Tests.Migration;

public sealed class TsPlanMigratorTests : IDisposable
{
    private readonly string root;
    private readonly TsPlanMigrator migrator;

    public TsPlanMigratorTests()
    {
        this.root = Path.Combine(
            AppContext.BaseDirectory,
            "ts-migration-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
        this.migrator = new TsPlanMigrator(new PassthroughFileSystem(), NullLogger<TsPlanMigrator>.Instance);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.root))
            {
                Directory.Delete(this.root, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    public async Task MigratesLegacyPlanJson()
    {
        var planDir = CopyFixtureToRoot("sample-plan");

        var count = await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(this.root), CancellationToken.None);

        Assert.Equal(1, count);
        Assert.True(File.Exists(Path.Combine(planDir, "checkpoint.json")));
    }

    [Fact]
    public async Task SkipsAlreadyMigrated()
    {
        var planDir = CopyFixtureToRoot("already-migrated");

        // Create a checkpoint.json so it looks already migrated.
        await File.WriteAllTextAsync(
            Path.Combine(planDir, "checkpoint.json"),
            "{\"upToSeq\":0,\"plan\":{}}");

        var count = await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(this.root), CancellationToken.None);

        Assert.Equal(0, count);
        // Original plan.json should still exist (not renamed).
        Assert.True(File.Exists(Path.Combine(planDir, "plan.json")));
    }

    [Fact]
    public async Task BackupsOriginalFile()
    {
        var planDir = CopyFixtureToRoot("backup-test");

        await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(this.root), CancellationToken.None);

        Assert.False(File.Exists(Path.Combine(planDir, "plan.json")));
        Assert.True(File.Exists(Path.Combine(planDir, "plan.json.migrated")));
    }

    [Fact]
    public void MapsAllStatuses()
    {
        Assert.Equal(PlanStatus.Pending, TsPlanMigrator.MapPlanStatus("pending"));
        Assert.Equal(PlanStatus.Running, TsPlanMigrator.MapPlanStatus("running"));
        Assert.Equal(PlanStatus.Succeeded, TsPlanMigrator.MapPlanStatus("succeeded"));
        Assert.Equal(PlanStatus.Failed, TsPlanMigrator.MapPlanStatus("failed"));
        Assert.Equal(PlanStatus.Canceled, TsPlanMigrator.MapPlanStatus("canceled"));
        Assert.Equal(PlanStatus.Canceled, TsPlanMigrator.MapPlanStatus("cancelled"));
        Assert.Equal(PlanStatus.Paused, TsPlanMigrator.MapPlanStatus("paused"));
        Assert.Equal(PlanStatus.Pending, TsPlanMigrator.MapPlanStatus(null));
        Assert.Equal(PlanStatus.Pending, TsPlanMigrator.MapPlanStatus("unknown_status"));

        Assert.Equal(JobStatus.Pending, TsPlanMigrator.MapJobStatus("pending"));
        Assert.Equal(JobStatus.Ready, TsPlanMigrator.MapJobStatus("ready"));
        Assert.Equal(JobStatus.Scheduled, TsPlanMigrator.MapJobStatus("scheduled"));
        Assert.Equal(JobStatus.Running, TsPlanMigrator.MapJobStatus("running"));
        Assert.Equal(JobStatus.Succeeded, TsPlanMigrator.MapJobStatus("succeeded"));
        Assert.Equal(JobStatus.Failed, TsPlanMigrator.MapJobStatus("failed"));
        Assert.Equal(JobStatus.Blocked, TsPlanMigrator.MapJobStatus("blocked"));
        Assert.Equal(JobStatus.Canceled, TsPlanMigrator.MapJobStatus("canceled"));
        Assert.Equal(JobStatus.Canceled, TsPlanMigrator.MapJobStatus("cancelled"));
        Assert.Equal(JobStatus.Skipped, TsPlanMigrator.MapJobStatus("skipped"));
        Assert.Equal(JobStatus.Pending, TsPlanMigrator.MapJobStatus(null));
    }

    [Fact]
    public void MapsTimestamps()
    {
        var ts = CreateSampleTsPlan();
        var plan = TsPlanMigrator.ConvertToPlan(ts);

        // 1776399900000 ms → 2026-04-25 in UTC
        Assert.Equal(
            DateTimeOffset.FromUnixTimeMilliseconds(1776399900000),
            plan.CreatedAt);

        Assert.NotNull(plan.StartedAt);
        Assert.Equal(
            DateTimeOffset.FromUnixTimeMilliseconds(1776400000000),
            plan.StartedAt!.Value);
    }

    [Fact]
    public void MapsJobDependencies()
    {
        var ts = CreateSampleTsPlan();
        var plan = TsPlanMigrator.ConvertToPlan(ts);

        var job1 = plan.Jobs["job-001"];
        Assert.Empty(job1.DependsOn);

        var job2 = plan.Jobs["job-002"];
        Assert.Equal(new[] { "job-001" }, job2.DependsOn);

        var job3 = plan.Jobs["job-003"];
        Assert.Equal(new[] { "job-001", "job-002" }, job3.DependsOn);
    }

    [Fact]
    public async Task EmptyDirectoryReturnsZero()
    {
        var count = await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(this.root), CancellationToken.None);

        Assert.Equal(0, count);
    }

    [Fact]
    public async Task NonExistentDirectoryReturnsZero()
    {
        var count = await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(Path.Combine(this.root, "nonexistent")), CancellationToken.None);

        Assert.Equal(0, count);
    }

    [Fact]
    public void ConvertToPlan_MapsStateTransitions()
    {
        var ts = CreateSampleTsPlan();
        var plan = TsPlanMigrator.ConvertToPlan(ts);

        var job1 = plan.Jobs["job-001"];
        Assert.Equal(3, job1.Transitions.Count);
        Assert.Equal(JobStatus.Scheduled, job1.Transitions[0].To);
        Assert.Equal(JobStatus.Running, job1.Transitions[1].To);
        Assert.Equal(JobStatus.Succeeded, job1.Transitions[2].To);
    }

    [Fact]
    public void ConvertToPlan_MapsAttempts()
    {
        var ts = CreateSampleTsPlan();
        var plan = TsPlanMigrator.ConvertToPlan(ts);

        var job1 = plan.Jobs["job-001"];
        Assert.Single(job1.Attempts);
        Assert.Equal(1, job1.Attempts[0].AttemptNumber);
        Assert.Equal(JobStatus.Succeeded, job1.Attempts[0].Status);

        // job-002 had 2 attempts.
        var job2 = plan.Jobs["job-002"];
        Assert.Equal(2, job2.Attempts.Count);
        Assert.Equal(1, job2.Attempts[0].AttemptNumber);
        Assert.Equal(2, job2.Attempts[1].AttemptNumber);
        Assert.Equal(JobStatus.Failed, job2.Attempts[1].Status);
        Assert.Equal("Build compilation error in module X", job2.Attempts[1].ErrorMessage);

        // job-003 has no attempts.
        var job3 = plan.Jobs["job-003"];
        Assert.Empty(job3.Attempts);
    }

    [Fact]
    public async Task CheckpointJsonIsValidFormat()
    {
        var planDir = CopyFixtureToRoot("checkpoint-format");

        await this.migrator.MigrateIfNeededAsync(
            new AbsolutePath(this.root), CancellationToken.None);

        var checkpointJson = await File.ReadAllTextAsync(
            Path.Combine(planDir, "checkpoint.json"));

        // Must be a valid JSON with upToSeq and plan keys.
        var doc = System.Text.Json.JsonDocument.Parse(checkpointJson);
        Assert.True(doc.RootElement.TryGetProperty("upToSeq", out var seq));
        Assert.Equal(0, seq.GetInt64());
        Assert.True(doc.RootElement.TryGetProperty("plan", out _));
    }

    private string CopyFixtureToRoot(string subDirName)
    {
        var destDir = Path.Combine(this.root, subDirName);
        Directory.CreateDirectory(destDir);

        var fixturePath = Path.Combine(
            AppContext.BaseDirectory,
            "TestData", "TsMigration", "sample-plan", "plan.json");
        File.Copy(fixturePath, Path.Combine(destDir, "plan.json"));

        return destDir;
    }

    private static TsPlanFormat CreateSampleTsPlan() => new()
    {
        Id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        Spec = new TsSpec { Name = "Test Migration Plan" },
        Status = "failed",
        CreatedAt = 1776399900000,
        StartedAt = 1776400000000,
        Jobs =
        [
            new TsJob { Id = "job-001", Name = "Foundation setup", Dependencies = [] },
            new TsJob { Id = "job-002", Name = "Core implementation", Dependencies = ["job-001"] },
            new TsJob { Id = "job-003", Name = "Integration tests", Dependencies = ["job-001", "job-002"] },
        ],
        NodeStates = new()
        {
            ["job-001"] = new TsNodeState
            {
                Status = "succeeded",
                Attempts = 1,
                StateHistory =
                [
                    new TsStateTransition { From = "", To = "scheduled", Timestamp = 1776400000000, Reason = "initial" },
                    new TsStateTransition { From = "scheduled", To = "running", Timestamp = 1776400001000 },
                    new TsStateTransition { From = "running", To = "succeeded", Timestamp = 1776400060000 },
                ],
                LastAttempt = new TsLastAttempt
                {
                    StartedAt = 1776400001000,
                    EndedAt = 1776400060000,
                    Status = "succeeded",
                },
            },
            ["job-002"] = new TsNodeState
            {
                Status = "failed",
                Attempts = 2,
                StateHistory =
                [
                    new TsStateTransition { From = "", To = "scheduled", Timestamp = 1776400061000, Reason = "dependency met" },
                    new TsStateTransition { From = "scheduled", To = "running", Timestamp = 1776400062000 },
                    new TsStateTransition { From = "running", To = "failed", Timestamp = 1776400120000 },
                ],
                LastAttempt = new TsLastAttempt
                {
                    StartedAt = 1776400062000,
                    EndedAt = 1776400120000,
                    Status = "failed",
                    Error = "Build compilation error in module X",
                },
            },
            ["job-003"] = new TsNodeState
            {
                Status = "pending",
                Attempts = 0,
                StateHistory = [],
            },
        },
    };
}
