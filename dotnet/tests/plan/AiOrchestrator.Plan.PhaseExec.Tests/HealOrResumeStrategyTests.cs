// <copyright file="HealOrResumeStrategyTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.TestKit.Time;
using Xunit;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>Comprehensive tests for all <see cref="HealOrResumeStrategy"/> decision paths.</summary>
public sealed class HealOrResumeStrategyTests
{
    private readonly HealOrResumeStrategy strategy = new(new InMemoryClock());

    private static JobNode MakeJob(string title = "test-job")
        => new() { Id = JobId.New().ToString(), Title = title, Status = JobStatus.Running };

    // ──────────────────────────────────────────────────────────────────────────
    // TransientNetwork → PhaseResume
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void TransientNetwork_AlwaysPhaseResume()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.TransientNetwork, JobPhase.MergeForwardIntegration,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.PhaseResume, decision.Mode);
        Assert.Equal(JobPhase.MergeForwardIntegration, decision.ResumeFromPhase);
        Assert.Contains("Transient", decision.Reason);
    }

    [Fact]
    public void TransientNetwork_ResumeEvenWhenAutoHealDisabled()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.TransientNetwork, JobPhase.Setup,
            prevHealAttempts: 0, maxAutoHealAttempts: 0, autoHealEnabled: false);

        Assert.Equal(ResumeMode.PhaseResume, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // TransientFileLock → PhaseResume
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void TransientFileLock_AlwaysPhaseResume()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.TransientFileLock, JobPhase.Commit,
            prevHealAttempts: 5, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.PhaseResume, decision.Mode);
        Assert.Equal(JobPhase.Commit, decision.ResumeFromPhase);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // AgentMaxTurnsExceeded
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AgentMaxTurnsExceeded_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AgentMaxTurnsExceeded, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Equal(JobPhase.Work, decision.ResumeFromPhase);
    }

    [Fact]
    public void AgentMaxTurnsExceeded_AutoHealDisabled_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AgentMaxTurnsExceeded, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
        Assert.Contains("disabled", decision.Reason);
    }

    [Fact]
    public void AgentMaxTurnsExceeded_CapReached_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AgentMaxTurnsExceeded, JobPhase.Work,
            prevHealAttempts: 3, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
        Assert.Contains("cap", decision.Reason);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // AgentNonZeroExit
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AgentNonZeroExit_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AgentNonZeroExit, JobPhase.Work,
            prevHealAttempts: 1, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Contains("2/3", decision.Reason);
    }

    [Fact]
    public void AgentNonZeroExit_AutoHealDisabled_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AgentNonZeroExit, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // AnalyzerOrTestFailure
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AnalyzerOrTestFailure_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AnalyzerOrTestFailure, JobPhase.Postchecks,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Equal(JobPhase.Work, decision.ResumeFromPhase);
    }

    [Fact]
    public void AnalyzerOrTestFailure_CapReached_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.AnalyzerOrTestFailure, JobPhase.Postchecks,
            prevHealAttempts: 3, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MergeConflict
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void MergeConflict_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.MergeConflict, JobPhase.MergeReverseIntegration,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Equal(JobPhase.Work, decision.ResumeFromPhase);
    }

    [Fact]
    public void MergeConflict_AutoHealDisabled_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.MergeConflict, JobPhase.MergeReverseIntegration,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    [Fact]
    public void MergeConflict_CapReached_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.MergeConflict, JobPhase.MergeForwardIntegration,
            prevHealAttempts: 3, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RemoteRejected → always GiveUp
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void RemoteRejected_AlwaysGivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.RemoteRejected, JobPhase.MergeReverseIntegration,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
        Assert.Contains("non-recoverable", decision.Reason);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ShellNonZeroExit
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void ShellNonZeroExit_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ShellNonZeroExit, JobPhase.Prechecks,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
        Assert.Equal(JobPhase.Work, decision.ResumeFromPhase);
    }

    [Fact]
    public void ShellNonZeroExit_AutoHealDisabled_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ShellNonZeroExit, JobPhase.Prechecks,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    [Fact]
    public void ShellNonZeroExit_CapReached_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ShellNonZeroExit, JobPhase.Prechecks,
            prevHealAttempts: 3, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Timeout → always GiveUp
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void Timeout_AlwaysGivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.Timeout, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
        Assert.Contains("Timeout", decision.Reason);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ProcessCrash
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void ProcessCrash_AutoHealEnabled_ReturnsAutoHeal()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ProcessCrash, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.AutoHeal, decision.Mode);
    }

    [Fact]
    public void ProcessCrash_AutoHealDisabled_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ProcessCrash, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: false);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    [Fact]
    public void ProcessCrash_CapReached_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.ProcessCrash, JobPhase.Work,
            prevHealAttempts: 3, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal → always GiveUp
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void Internal_AlwaysGivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), PhaseFailureKind.Internal, JobPhase.Setup,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
        Assert.Contains("Internal", decision.Reason);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Unknown / default → GiveUp
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void UnknownKind_GivesUp()
    {
        var decision = this.strategy.Decide(
            MakeJob(), (PhaseFailureKind)999, JobPhase.Work,
            prevHealAttempts: 0, maxAutoHealAttempts: 3, autoHealEnabled: true);

        Assert.Equal(ResumeMode.GiveUp, decision.Mode);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Null guards
    // ──────────────────────────────────────────────────────────────────────────

    [Fact]
    public void Constructor_ThrowsOnNullClock()
    {
        Assert.Throws<ArgumentNullException>(() => new HealOrResumeStrategy(null!));
    }

    [Fact]
    public void Decide_ThrowsOnNullJob()
    {
        Assert.Throws<ArgumentNullException>(() => this.strategy.Decide(
            null!, PhaseFailureKind.Internal, JobPhase.Work, 0, 3, true));
    }
}
