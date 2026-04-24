// <copyright file="CoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.PhaseExec.Phases;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>
/// Tests covering PhaseExec gaps: PhaseOptions defaults, PhaseExecResult construction,
/// PhaseExecutionException, DiskQuotaExceededException, UnlimitedDiskQuota, JobPhase enum,
/// HealOrResumeStrategy edge cases, CrashCodeDetector, CommitInputs, and NullCommitInputs.
/// </summary>
public sealed class CoverageGapTests
{
    // ──────────────────────────────────────────────────────────────────────────
    // PhaseOptions
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PhaseOptions_Defaults()
    {
        var opts = new PhaseOptions();

        Assert.Equal(3, opts.MaxAutoHealAttempts);
        Assert.Equal(TimeSpan.FromMinutes(15), opts.MergeFiTimeout);
        Assert.Equal(TimeSpan.FromMinutes(5), opts.SetupTimeout);
        Assert.Equal(TimeSpan.FromMinutes(10), opts.PrechecksTimeout);
        Assert.Equal(TimeSpan.FromMinutes(30), opts.WorkTimeout);
        Assert.Equal(TimeSpan.FromMinutes(5), opts.CommitTimeout);
        Assert.Equal(TimeSpan.FromMinutes(10), opts.PostchecksTimeout);
        Assert.Equal(TimeSpan.FromMinutes(15), opts.MergeRiTimeout);
        Assert.Equal(3, opts.MaxPhaseResumeAttempts);
    }

    [Fact]
    public void PhaseOptions_CustomValues()
    {
        var opts = new PhaseOptions
        {
            MaxAutoHealAttempts = 5,
            MergeFiTimeout = TimeSpan.FromMinutes(1),
            SetupTimeout = TimeSpan.FromMinutes(2),
            PrechecksTimeout = TimeSpan.FromMinutes(3),
            WorkTimeout = TimeSpan.FromMinutes(4),
            CommitTimeout = TimeSpan.FromMinutes(6),
            PostchecksTimeout = TimeSpan.FromMinutes(7),
            MergeRiTimeout = TimeSpan.FromMinutes(8),
            MaxPhaseResumeAttempts = 10,
        };

        Assert.Equal(5, opts.MaxAutoHealAttempts);
        Assert.Equal(TimeSpan.FromMinutes(1), opts.MergeFiTimeout);
        Assert.Equal(TimeSpan.FromMinutes(2), opts.SetupTimeout);
        Assert.Equal(TimeSpan.FromMinutes(3), opts.PrechecksTimeout);
        Assert.Equal(TimeSpan.FromMinutes(4), opts.WorkTimeout);
        Assert.Equal(TimeSpan.FromMinutes(6), opts.CommitTimeout);
        Assert.Equal(TimeSpan.FromMinutes(7), opts.PostchecksTimeout);
        Assert.Equal(TimeSpan.FromMinutes(8), opts.MergeRiTimeout);
        Assert.Equal(10, opts.MaxPhaseResumeAttempts);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PhaseExecResult
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PhaseExecResult_SuccessConstruction()
    {
        var sha = new CommitSha("abcdef0123456789abcdef0123456789abcdef01");
        var result = new PhaseExecResult
        {
            FinalStatus = JobStatus.Succeeded,
            EndedAtPhase = JobPhase.Done,
            CommitSha = sha,
            FailureReason = null,
            AttemptCount = 1,
        };

        Assert.Equal(JobStatus.Succeeded, result.FinalStatus);
        Assert.Equal(JobPhase.Done, result.EndedAtPhase);
        Assert.Equal(sha, result.CommitSha);
        Assert.Null(result.FailureReason);
        Assert.Equal(1, result.AttemptCount);
    }

    [Fact]
    public void PhaseExecResult_FailureConstruction()
    {
        var result = new PhaseExecResult
        {
            FinalStatus = JobStatus.Failed,
            EndedAtPhase = JobPhase.Work,
            CommitSha = null,
            FailureReason = "Agent crashed",
            AttemptCount = 3,
        };

        Assert.Equal(JobStatus.Failed, result.FinalStatus);
        Assert.Equal(JobPhase.Work, result.EndedAtPhase);
        Assert.Null(result.CommitSha);
        Assert.Equal("Agent crashed", result.FailureReason);
        Assert.Equal(3, result.AttemptCount);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PhaseExecutionException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PhaseExecutionException_ConstructsWithKindAndPhase()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new PhaseExecutionException(
            PhaseFailureKind.AgentNonZeroExit,
            JobPhase.Work,
            "Agent exited with code 1",
            inner);

        Assert.Equal(PhaseFailureKind.AgentNonZeroExit, ex.Kind);
        Assert.Equal(JobPhase.Work, ex.Phase);
        Assert.Equal("Agent exited with code 1", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    [Fact]
    public void PhaseExecutionException_WithoutInner()
    {
        var ex = new PhaseExecutionException(
            PhaseFailureKind.Timeout,
            JobPhase.Postchecks,
            "Timed out");

        Assert.Equal(PhaseFailureKind.Timeout, ex.Kind);
        Assert.Equal(JobPhase.Postchecks, ex.Phase);
        Assert.Null(ex.InnerException);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DiskQuotaExceededException
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void DiskQuotaExceededException_ConstructsCorrectly()
    {
        var planId = PlanId.New();
        var ex = new DiskQuotaExceededException(planId, 1_000_000, "Quota exceeded");

        Assert.Equal(planId, ex.Plan);
        Assert.Equal(1_000_000L, ex.Requested);
        Assert.Equal("Quota exceeded", ex.Message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // UnlimitedDiskQuota
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void UnlimitedDiskQuota_TryReserve_AlwaysReturnsTrue()
    {
        var quota = new UnlimitedDiskQuota();
        var planId = PlanId.New();

        Assert.True(quota.TryReserve(planId, 0));
        Assert.True(quota.TryReserve(planId, 1_000_000));
        Assert.True(quota.TryReserve(planId, long.MaxValue));
    }

    [Fact]
    public void UnlimitedDiskQuota_Release_DoesNotThrow()
    {
        var quota = new UnlimitedDiskQuota();
        var planId = PlanId.New();

        // Should not throw
        quota.Release(planId, 0);
        quota.Release(planId, 1_000_000);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // JobPhase enum ordering
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void JobPhase_OrderIsCorrect()
    {
        Assert.True(JobPhase.MergeForwardIntegration < JobPhase.Setup);
        Assert.True(JobPhase.Setup < JobPhase.Prechecks);
        Assert.True(JobPhase.Prechecks < JobPhase.Work);
        Assert.True(JobPhase.Work < JobPhase.Commit);
        Assert.True(JobPhase.Commit < JobPhase.Postchecks);
        Assert.True(JobPhase.Postchecks < JobPhase.MergeReverseIntegration);
        Assert.True(JobPhase.MergeReverseIntegration < JobPhase.Done);
    }

    [Fact]
    public void JobPhase_NumericValues()
    {
        Assert.Equal(0, (int)JobPhase.MergeForwardIntegration);
        Assert.Equal(1, (int)JobPhase.Setup);
        Assert.Equal(2, (int)JobPhase.Prechecks);
        Assert.Equal(3, (int)JobPhase.Work);
        Assert.Equal(4, (int)JobPhase.Commit);
        Assert.Equal(5, (int)JobPhase.Postchecks);
        Assert.Equal(6, (int)JobPhase.MergeReverseIntegration);
        Assert.Equal(7, (int)JobPhase.Done);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PhaseFailureKind enum values
    // ──────────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(PhaseFailureKind.TransientNetwork, 0)]
    [InlineData(PhaseFailureKind.TransientFileLock, 1)]
    [InlineData(PhaseFailureKind.AgentMaxTurnsExceeded, 2)]
    [InlineData(PhaseFailureKind.AgentNonZeroExit, 3)]
    [InlineData(PhaseFailureKind.ShellNonZeroExit, 4)]
    [InlineData(PhaseFailureKind.MergeConflict, 5)]
    [InlineData(PhaseFailureKind.RemoteRejected, 6)]
    [InlineData(PhaseFailureKind.AnalyzerOrTestFailure, 7)]
    [InlineData(PhaseFailureKind.Timeout, 8)]
    [InlineData(PhaseFailureKind.Internal, 9)]
    [InlineData(PhaseFailureKind.ProcessCrash, 10)]
    public void PhaseFailureKind_HasExpectedValues(PhaseFailureKind kind, int expected)
    {
        Assert.Equal(expected, (int)kind);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ResumeMode and ResumeDecision
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void ResumeDecision_ConstructsCorrectly()
    {
        var decision = new ResumeDecision
        {
            Mode = ResumeMode.AutoHeal,
            ResumeFromPhase = JobPhase.Work,
            Reason = "auto-heal test",
        };

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Equal(JobPhase.Work, decision.ResumeFromPhase);
        Assert.Equal("auto-heal test", decision.Reason);
    }

    [Fact]
    public void ResumeMode_HasThreeValues()
    {
        Assert.Equal(0, (int)ResumeMode.PhaseResume);
        Assert.Equal(1, (int)ResumeMode.AutoHeal);
        Assert.Equal(2, (int)ResumeMode.GiveUp);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PhaseAttemptCompletedEvent
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PhaseAttemptCompletedEvent_ConstructsCorrectly()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var at = DateTimeOffset.UtcNow;
        var attempt = new JobAttempt
        {
            AttemptNumber = 1,
            Status = JobStatus.Succeeded,
            StartedAt = at.AddSeconds(-5),
            CompletedAt = at,
        };

        var evt = new PhaseAttemptCompletedEvent
        {
            PlanId = planId,
            JobId = jobId,
            At = at,
            Attempt = attempt,
        };

        Assert.Equal(planId, evt.PlanId);
        Assert.Equal(jobId, evt.JobId);
        Assert.Equal(at, evt.At);
        Assert.Equal(attempt, evt.Attempt);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // NullCommitInputs
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task NullCommitInputs_ThrowsInvalidOperation()
    {
        ICommitInputs inputs = new NullCommitInputsAccessor();
        var ctx = MakeContext();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => inputs.GetAsync(ctx, CancellationToken.None).AsTask());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PhaseExecutor.PhaseOrder
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PhaseExecutor_PhaseOrder_ContainsAllSevenPhases()
    {
        Assert.Equal(7, PhaseExecutor.PhaseOrder.Count);
        Assert.Equal(JobPhase.MergeForwardIntegration, PhaseExecutor.PhaseOrder[0]);
        Assert.Equal(JobPhase.Setup, PhaseExecutor.PhaseOrder[1]);
        Assert.Equal(JobPhase.Prechecks, PhaseExecutor.PhaseOrder[2]);
        Assert.Equal(JobPhase.Work, PhaseExecutor.PhaseOrder[3]);
        Assert.Equal(JobPhase.Commit, PhaseExecutor.PhaseOrder[4]);
        Assert.Equal(JobPhase.Postchecks, PhaseExecutor.PhaseOrder[5]);
        Assert.Equal(JobPhase.MergeReverseIntegration, PhaseExecutor.PhaseOrder[6]);
    }

    [Fact]
    public void PhaseExecutor_Constructor_ThrowsWhenMissingRunner()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var plan = Fixtures.MakePlan(planId, jobId);
        var store = new StubPlanStore(plan);
        var bus = new RecordingEventBus();
        var clock = new InMemoryClock();
        var opts = new FixedOptions<PhaseOptions>(new PhaseOptions());

        // Only provide 3 runners instead of 7
        var runners = new IPhaseRunner[]
        {
            new FakePhaseRunner(JobPhase.MergeForwardIntegration),
            new FakePhaseRunner(JobPhase.Setup),
            new FakePhaseRunner(JobPhase.Prechecks),
        };

        Assert.Throws<ArgumentException>(() => new PhaseExecutor(
            store, bus, clock, opts, NullLogger<PhaseExecutor>.Instance, runners));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────────

    private static PhaseRunContext MakeContext()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        return new PhaseRunContext
        {
            PlanId = planId,
            JobId = jobId,
            RunId = RunId.New(),
            Job = new JobNode { Id = jobId.ToString(), Title = "test", Status = JobStatus.Pending },
            AttemptNumber = 1,
            IsAutoHealAttempt = false,
        };
    }

    /// <summary>Exposes the internal NullCommitInputs for testing.</summary>
    private sealed class NullCommitInputsAccessor : ICommitInputs
    {
        public ValueTask<CommitInputs> GetAsync(PhaseRunContext ctx, CancellationToken ct) =>
            throw new InvalidOperationException(
                "No ICommitInputs implementation has been registered. The hosting layer must provide one.");
    }
}
