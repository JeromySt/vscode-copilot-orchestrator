// <copyright file="TsPlanMigrator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using Microsoft.Extensions.Logging;

using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.Store.Migration;

/// <summary>
/// Migrates legacy TS-format <c>plan.json</c> files to .NET <c>checkpoint.json</c> format.
/// After migration, the original file is renamed to <c>plan.json.migrated</c> as a backup.
/// Directories that already contain <c>checkpoint.json</c> are skipped.
/// </summary>
public sealed class TsPlanMigrator : IPlanMigrator
{
    private const string TsPlanFileName = "plan.json";
    private const string CheckpointFileName = "checkpoint.json";
    private const string MigratedSuffix = ".migrated";

    private readonly IFileSystem fs;
    private readonly ILogger<TsPlanMigrator> logger;

    /// <summary>Initializes a new <see cref="TsPlanMigrator"/>.</summary>
    public TsPlanMigrator(IFileSystem fs, ILogger<TsPlanMigrator> logger)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <inheritdoc/>
    public async ValueTask<int> MigrateIfNeededAsync(AbsolutePath planStoreRoot, CancellationToken ct)
    {
        if (!await this.fs.DirectoryExistsAsync(planStoreRoot, ct).ConfigureAwait(false))
        {
            return 0;
        }

        var migrated = 0;

        await foreach (var dir in this.fs.EnumerateDirectoriesAsync(planStoreRoot, ct).ConfigureAwait(false))
        {
            ct.ThrowIfCancellationRequested();

            var planJsonPath = new AbsolutePath(Path.Combine(dir.Value, TsPlanFileName));
            var checkpointPath = new AbsolutePath(Path.Combine(dir.Value, CheckpointFileName));

            // Skip if no TS plan.json or already migrated.
            if (!await this.fs.FileExistsAsync(planJsonPath, ct).ConfigureAwait(false) ||
                await this.fs.FileExistsAsync(checkpointPath, ct).ConfigureAwait(false))
            {
                continue;
            }

            try
            {
                var json = await this.fs.ReadAllTextAsync(planJsonPath, ct).ConfigureAwait(false);
                var tsPlan = JsonSerializer.Deserialize<TsPlanFormat>(json);
                if (tsPlan is null)
                {
                    this.logger.LogWarning("Skipping {Path}: deserialization returned null.", planJsonPath.Value);
                    continue;
                }

                var plan = ConvertToPlan(tsPlan);
                var checkpoint = BuildCheckpointJson(plan);

                await this.fs.WriteAllTextAsync(checkpointPath, checkpoint, ct).ConfigureAwait(false);

                // Backup original via atomic move.
                var backupPath = new AbsolutePath(planJsonPath.Value + MigratedSuffix);
                await this.fs.MoveAtomicAsync(planJsonPath, backupPath, ct).ConfigureAwait(false);

                migrated++;
                this.logger.LogInformation("Migrated plan {PlanId} from TS format.", plan.Id);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                this.logger.LogError(ex, "Failed to migrate plan in {Directory}.", dir.Value);
            }
        }

        return migrated;
    }

    internal static PlanModel ConvertToPlan(TsPlanFormat ts)
    {
        // Build job lookup from the TS jobs array (id → TsJob).
        var jobLookup = (ts.Jobs ?? []).ToDictionary(j => j.Id, j => j);

        var jobs = new Dictionary<string, JobNode>();

        if (ts.NodeStates is not null)
        {
            foreach (var (nodeId, state) in ts.NodeStates)
            {
                jobLookup.TryGetValue(nodeId, out var tsJob);

                var transitions = (state.StateHistory ?? [])
                    .Select(t => new StateTransition
                    {
                        From = MapJobStatus(t.From),
                        To = MapJobStatus(t.To),
                        OccurredAt = t.Timestamp.HasValue
                            ? DateTimeOffset.FromUnixTimeMilliseconds(t.Timestamp.Value)
                            : default,
                        Reason = t.Reason,
                    })
                    .ToArray();

                var attempts = BuildAttempts(state);

                // Derive start/completed from transitions.
                var startedAt = transitions.Length > 0 ? transitions[0].OccurredAt : (DateTimeOffset?)null;
                var completedAt = state.Status is "succeeded" or "failed" or "canceled"
                    && transitions.Length > 0
                    ? transitions[^1].OccurredAt
                    : (DateTimeOffset?)null;

                var node = new JobNode
                {
                    Id = nodeId,
                    Title = tsJob?.Name ?? nodeId,
                    Status = MapJobStatus(state.Status),
                    DependsOn = tsJob?.Dependencies ?? [],
                    Attempts = attempts,
                    Transitions = transitions,
                    StartedAt = startedAt,
                    CompletedAt = completedAt,
                };

                jobs[nodeId] = node;
            }
        }

        return new PlanModel
        {
            Id = ts.Id,
            Name = ts.Spec?.Name ?? string.Empty,
            Status = MapPlanStatus(ts.Status),
            CreatedAt = ts.CreatedAt.HasValue
                ? DateTimeOffset.FromUnixTimeMilliseconds(ts.CreatedAt.Value)
                : default,
            StartedAt = ts.StartedAt.HasValue
                ? DateTimeOffset.FromUnixTimeMilliseconds(ts.StartedAt.Value)
                : null,
            Jobs = jobs,
        };
    }

    internal static JobStatus MapJobStatus(string? status) => status?.ToLowerInvariant() switch
    {
        "pending" => JobStatus.Pending,
        "ready" => JobStatus.Ready,
        "scheduled" => JobStatus.Scheduled,
        "running" => JobStatus.Running,
        "succeeded" => JobStatus.Succeeded,
        "failed" => JobStatus.Failed,
        "blocked" => JobStatus.Blocked,
        "canceled" or "cancelled" => JobStatus.Canceled,
        "skipped" => JobStatus.Skipped,
        null or "" => JobStatus.Pending,
        _ => JobStatus.Pending,
    };

    internal static PlanStatus MapPlanStatus(string? status) => status?.ToLowerInvariant() switch
    {
        "pending" => PlanStatus.Pending,
        "running" => PlanStatus.Running,
        "succeeded" => PlanStatus.Succeeded,
        "failed" => PlanStatus.Failed,
        "canceled" or "cancelled" => PlanStatus.Canceled,
        "paused" => PlanStatus.Paused,
        "partial" => PlanStatus.Partial,
        null or "" => PlanStatus.Pending,
        _ => PlanStatus.Pending,
    };

    private static IReadOnlyList<JobAttempt> BuildAttempts(TsNodeState state)
    {
        if (state.Attempts <= 0 && state.LastAttempt is null)
        {
            return [];
        }

        var attemptCount = Math.Max(state.Attempts, 1);
        var result = new List<JobAttempt>(attemptCount);

        // We only have detail for the last attempt from the TS format.
        for (var i = 1; i <= attemptCount; i++)
        {
            if (i == attemptCount && state.LastAttempt is not null)
            {
                var la = state.LastAttempt;
                result.Add(new JobAttempt
                {
                    AttemptNumber = i,
                    Status = MapJobStatus(la.Status),
                    StartedAt = la.StartedAt.HasValue
                        ? DateTimeOffset.FromUnixTimeMilliseconds(la.StartedAt.Value)
                        : default,
                    CompletedAt = la.EndedAt.HasValue
                        ? DateTimeOffset.FromUnixTimeMilliseconds(la.EndedAt.Value)
                        : null,
                    ErrorMessage = la.Error,
                });
            }
            else
            {
                // Earlier attempts have no detail in the TS format.
                result.Add(new JobAttempt
                {
                    AttemptNumber = i,
                    Status = i < attemptCount ? JobStatus.Failed : MapJobStatus(state.Status),
                });
            }
        }

        return result;
    }

    private static string BuildCheckpointJson(PlanModel plan)
    {
        var planJson = PlanJson.Serialize(plan);
        return "{\"upToSeq\":0,\"plan\":" + planJson + "}";
    }
}
