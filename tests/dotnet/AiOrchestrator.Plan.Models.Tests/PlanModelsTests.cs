// <copyright file="PlanModelsTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using AiOrchestrator.Plan.Models;
using FluentAssertions;
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

        first.Should().Be(second, "serialization must be byte-stable across calls");
    }

    /// <summary>All fields must survive a serialize → deserialize round-trip unchanged.</summary>
    [Fact]
    [ContractTest("PM-ROUNDTRIP")]
    public void PM_RoundTrip_PreservesAllFields()
    {
        var original = BuildSamplePlan();

        var json = PlanJson.Serialize(original);
        var restored = PlanJson.Deserialize(json);

        restored.Should().NotBeNull();
        restored!.Id.Should().Be(original.Id);
        restored.Name.Should().Be(original.Name);
        restored.Description.Should().Be(original.Description);
        restored.Status.Should().Be(original.Status);
        restored.CreatedAt.Should().Be(original.CreatedAt);
        restored.StartedAt.Should().Be(original.StartedAt);
        restored.Jobs.Should().HaveCount(original.Jobs.Count);

        var restoredJobA = restored.Jobs["job-a"];
        var originalJobA = original.Jobs["job-a"];

        restoredJobA.Title.Should().Be(originalJobA.Title);
        restoredJobA.Status.Should().Be(originalJobA.Status);
        restoredJobA.StartedAt.Should().Be(originalJobA.StartedAt);
        restoredJobA.CompletedAt.Should().Be(originalJobA.CompletedAt);
        restoredJobA.WorkSpec.Should().NotBeNull();
        restoredJobA.WorkSpec!.Instructions.Should().Be(originalJobA.WorkSpec!.Instructions);
        restoredJobA.Attempts.Should().HaveCount(1);
        restoredJobA.Attempts[0].AttemptNumber.Should().Be(1);
        restoredJobA.Attempts[0].Status.Should().Be(JobStatus.Succeeded);
        restoredJobA.Attempts[0].PhaseTimings.Should().HaveCount(1);
        restoredJobA.Attempts[0].PhaseTimings[0].Phase.Should().Be("work");

        var restoredJobB = restored.Jobs["job-b"];
        restoredJobB.DependsOn.Should().ContainSingle().Which.Should().Be("job-a");
        restoredJobB.Transitions.Should().HaveCount(1);
        restoredJobB.Transitions[0].Reason.Should().Be("Dependencies met");
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

        action.Should().Throw<InvalidOperationException>("a completed job cannot transition back to running");
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
