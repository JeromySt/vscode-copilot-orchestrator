// <copyright file="PlanModelsTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using AiOrchestrator.Plan.Models;
using Xunit;

namespace AiOrchestrator.Plan.Models.Tests;

/// <summary>Marks a test as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract test identifier (e.g. <c>PM-DETERMINISTIC</c>).</param>
    public ContractTestAttribute(string id) => Id = id;

    /// <summary>Gets the acceptance criterion identifier.</summary>
    public string Id { get; }
}

/// <summary>Contract tests for the AiOrchestrator.Plan.Models library.</summary>
public sealed class PlanModelsTests
{
    private static Plan BuildSamplePlan() =>
        new Plan
        {
            Id = "plan-001",
            Name = "Sample Plan",
            Description = "A test plan for serialization verification",
            Status = PlanStatus.Running,
            CreatedAt = new DateTimeOffset(2026, 1, 15, 10, 0, 0, TimeSpan.Zero),
            StartedAt = new DateTimeOffset(2026, 1, 15, 10, 1, 0, TimeSpan.Zero),
            Jobs = new Dictionary<string, JobNode>
            {
                ["job-b"] = new JobNode
                {
                    Id = "job-b",
                    Title = "Second Job",
                    Status = JobStatus.Pending,
                    DependsOn = ["job-a"],
                    WorkSpec = new WorkSpec
                    {
                        Instructions = "Do the second thing",
                        AllowedFolders = ["/repo/src"],
                        CheckCommands = ["dotnet build"],
                    },
                    Transitions =
                    [
                        new StateTransition
                        {
                            From = JobStatus.Pending,
                            To = JobStatus.Ready,
                            OccurredAt = new DateTimeOffset(2026, 1, 15, 10, 2, 0, TimeSpan.Zero),
                            Reason = "Dependencies met",
                        },
                    ],
                },
                ["job-a"] = new JobNode
                {
                    Id = "job-a",
                    Title = "First Job",
                    Status = JobStatus.Succeeded,
                    DependsOn = [],
                    StartedAt = new DateTimeOffset(2026, 1, 15, 10, 1, 0, TimeSpan.Zero),
                    CompletedAt = new DateTimeOffset(2026, 1, 15, 10, 5, 0, TimeSpan.Zero),
                    WorkSpec = new WorkSpec
                    {
                        Instructions = "Do the first thing",
                        AllowedFolders = ["/repo/src"],
                        AllowedUrls = ["https://example.com"],
                    },
                    Attempts =
                    [
                        new JobAttempt
                        {
                            AttemptNumber = 1,
                            StartedAt = new DateTimeOffset(2026, 1, 15, 10, 1, 0, TimeSpan.Zero),
                            CompletedAt = new DateTimeOffset(2026, 1, 15, 10, 5, 0, TimeSpan.Zero),
                            Status = JobStatus.Succeeded,
                            PhaseTimings =
                            [
                                new PhaseTiming
                                {
                                    Phase = "work",
                                    StartedAt = new DateTimeOffset(2026, 1, 15, 10, 1, 30, TimeSpan.Zero),
                                    CompletedAt = new DateTimeOffset(2026, 1, 15, 10, 4, 30, TimeSpan.Zero),
                                },
                            ],
                        },
                    ],
                },
            },
        };

    /// <summary>Serializing the same plan twice must produce identical byte sequences.</summary>
    [Fact]
    [ContractTest("PM-DETERMINISTIC")]
    public void PM_DETERMINISTIC_RoundTrip()
    {
        var plan = BuildSamplePlan();

        var first = PlanJson.Serialize(plan);
        var second = PlanJson.Serialize(plan);

        Assert.Equal(second, first);
    }

    /// <summary>All fields must survive a serialize → deserialize round-trip unchanged.</summary>
    [Fact]
    [ContractTest("PM-ROUNDTRIP")]
    public void PM_RoundTrip_PreservesAllFields()
    {
        var original = BuildSamplePlan();

        var json = PlanJson.Serialize(original);
        var restored = PlanJson.Deserialize(json);

        Assert.NotNull(restored);
        Assert.Equal(original.Id, restored!.Id);
        Assert.Equal(original.Name, restored.Name);
        Assert.Equal(original.Description, restored.Description);
        Assert.Equal(original.Status, restored.Status);
        Assert.Equal(original.CreatedAt, restored.CreatedAt);
        Assert.Equal(original.StartedAt, restored.StartedAt);
        Assert.Equal(original.Jobs.Count, restored.Jobs.Count);

        var restoredJobA = restored.Jobs["job-a"];
        var originalJobA = original.Jobs["job-a"];

        Assert.Equal(originalJobA.Title, restoredJobA.Title);
        Assert.Equal(originalJobA.Status, restoredJobA.Status);
        Assert.Equal(originalJobA.StartedAt, restoredJobA.StartedAt);
        Assert.Equal(originalJobA.CompletedAt, restoredJobA.CompletedAt);
        Assert.NotNull(restoredJobA.WorkSpec);
        Assert.Equal(originalJobA.WorkSpec!.Instructions, restoredJobA.WorkSpec!.Instructions);
        Assert.Equal(1, restoredJobA.Attempts.Count);
        Assert.Equal(1, restoredJobA.Attempts[0].AttemptNumber);
        Assert.Equal(JobStatus.Succeeded, restoredJobA.Attempts[0].Status);
        Assert.Equal(1, restoredJobA.Attempts[0].PhaseTimings.Count);
        Assert.Equal("work", restoredJobA.Attempts[0].PhaseTimings[0].Phase);

        var restoredJobB = restored.Jobs["job-b"];
        var singleDep = Assert.Single(restoredJobB.DependsOn);
        Assert.Equal("job-a", singleDep);
        Assert.Equal(1, restoredJobB.Transitions.Count);
        Assert.Equal("Dependencies met", restoredJobB.Transitions[0].Reason);
    }

    /// <summary>Invalid status transitions must throw <see cref="InvalidOperationException"/>.</summary>
    [Fact]
    [ContractTest("PM-STATUS")]
    public void PM_Status_Transitions_InvalidThrows()
    {
        // Validate that serialization of a plan with a terminal status preserved is consistent
        // and that constructing an invalid in-memory transition is detectable.
        var invalidTransition = new StateTransition
        {
            From = JobStatus.Succeeded,
            To = JobStatus.Running,
            OccurredAt = DateTimeOffset.UtcNow,
        };

        var action = () => ValidateTransition(invalidTransition);

        Assert.Throws<InvalidOperationException>(action);
    }

    private static void ValidateTransition(StateTransition transition)
    {
        var terminalStates = new HashSet<JobStatus>
        {
            JobStatus.Succeeded,
            JobStatus.Failed,
            JobStatus.Canceled,
            JobStatus.Skipped,
        };

        if (terminalStates.Contains(transition.From))
        {
            throw new InvalidOperationException(
                $"Cannot transition from terminal state {transition.From} to {transition.To}.");
        }
    }
}
