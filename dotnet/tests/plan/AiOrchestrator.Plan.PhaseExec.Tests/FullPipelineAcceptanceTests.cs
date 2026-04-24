// <copyright file="FullPipelineAcceptanceTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.PhaseExec;
using AiOrchestrator.Plan.PhaseExec.Phases;
using AiOrchestrator.Plan.Scheduler;
using AiOrchestrator.Plan.Scheduler.Completion;
using AiOrchestrator.Plan.Scheduler.Events;
using AiOrchestrator.Plan.Store;
using AiOrchestrator.Plan.Store.Events;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>
/// End-to-end acceptance tests that exercise the ENTIRE plan execution pipeline with
/// real git operations AND validate every event emitted. Uses a manual scheduler loop
/// that publishes <see cref="JobReadyEvent"/> and <see cref="JobScheduledEvent"/>,
/// a real <see cref="PlanStore"/>, real <see cref="PhaseExecutor"/>, real
/// <see cref="PlanCompletionHandler"/>, and a <see cref="FullRecordingEventBus"/>
/// to capture and assert on all published events.
/// </summary>
[Trait("Category", "FullPipeline")]
public sealed class FullPipelineAcceptanceTests : IDisposable
{
    private readonly string storeRoot;
    private readonly InMemoryClock clock;
    private readonly FullRecordingEventBus bus;

    public FullPipelineAcceptanceTests()
    {
        this.storeRoot = Path.Combine(Path.GetTempPath(), "full-pipeline", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.storeRoot);
        this.clock = new InMemoryClock();
        this.bus = new FullRecordingEventBus();
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.storeRoot))
            {
                ForceDeleteDirectory(this.storeRoot);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Test 1: Fan-out/fan-in with SV node — all events validated
    // ══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Exercises a full fan-out/fan-in pipeline with an SV node:
    /// <c>Root → {Work1, Work2, Work3} → SV(__snapshot-validation__) → Final</c>.
    ///
    /// Validates:
    /// <list type="bullet">
    /// <item>Exactly 6 <see cref="JobReadyEvent"/> (one per job)</item>
    /// <item>Exactly 6 <see cref="PhaseAttemptCompletedEvent"/> (AttemptNumber=1, Succeeded)</item>
    /// <item>No <see cref="JobBlockedEvent"/> (nothing failed)</item>
    /// <item>Event ordering: Root before Work1/2/3, Work1/2/3 before SV, SV before Final</item>
    /// <item>All 6 files present on main branch with expected content</item>
    /// <item>Plan status = Succeeded, all jobs Succeeded, each with 1 attempt</item>
    /// <item>SV node DependsOn = [Work1, Work2, Work3], Final DependsOn = [SV]</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("FULL-PIPELINE-FANOUT-SV")]
    public async Task FULL_PIPELINE_FanOutFanIn_WithSvNode_AllEventsValidated()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "full-pipeline-fanout-sv", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Build DAG: Root → {Work1, Work2, Work3} → SV → Final
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("root"), "Root");
        await AddJob(store, planId, ids.Register("work1"), "Work1", ids["root"]);
        await AddJob(store, planId, ids.Register("work2"), "Work2", ids["root"]);
        await AddJob(store, planId, ids.Register("work3"), "Work3", ids["root"]);

        // Build SV node depending on [Work1, Work2, Work3]
        var svJobId = ids.Register("sv");
        var svNode = SvNodeBuilder.Build(
            new[] { ids.Key("work1"), ids.Key("work2"), ids.Key("work3") })
            with { Id = svJobId.ToString() };
        await Mutate(store, planId, new JobAdded(0, default, default, svNode));

        // Final depends on SV
        await AddJob(store, planId, ids.Register("final"), "Final", ids["sv"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("root")] = ("root.txt", "Output from Root"),
            [ids.Key("work1")] = ("work1.txt", "Output from Work1"),
            [ids.Key("work2")] = ("work2.txt", "Output from Work2"),
            [ids.Key("work3")] = ("work3.txt", "Output from Work3"),
            [ids.Key("sv")] = ("verified.txt", "Output from SV"),
            [ids.Key("final")] = ("final.txt", "Output from Final"),
        };

        var exec = this.MakeGitExecutor(store, fixture, fileMap);
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);

        // ── Execute Root ──
        fixture.CreateWorktree(ids.Key("root"));
        await this.ExecuteJobWithEvents(store, exec, planId, ids["root"]);
        fixture.MergeWorktreeToMain(ids.Key("root"));
        await handler.ProcessAsync(planId, CancellationToken.None);

        // ── Fan-out: Work1, Work2, Work3 all ready ──
        var readyFanOut = await ComputeReadySet(store, planId);
        Assert.Equal(3, readyFanOut.Count);

        foreach (var name in new[] { "work1", "work2", "work3" })
        {
            fixture.CreateWorktree(ids.Key(name));
            await this.ExecuteJobWithEvents(store, exec, planId, ids[name]);
            fixture.MergeWorktreeToMain(ids.Key(name));
        }

        await handler.ProcessAsync(planId, CancellationToken.None);

        // ── SV ready ──
        var readySv = await ComputeReadySet(store, planId);
        Assert.Single(readySv);

        fixture.CreateWorktree(ids.Key("sv"));
        await this.ExecuteJobWithEvents(store, exec, planId, ids["sv"]);
        fixture.MergeWorktreeToMain(ids.Key("sv"));
        await handler.ProcessAsync(planId, CancellationToken.None);

        // ── Final ready ──
        var readyFinal = await ComputeReadySet(store, planId);
        Assert.Single(readyFinal);

        fixture.CreateWorktree(ids.Key("final"));
        await this.ExecuteJobWithEvents(store, exec, planId, ids["final"]);
        fixture.MergeWorktreeToMain(ids.Key("final"));

        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        // ════════════════════════════════════════════════════════════
        // EVENT ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 1. Exactly 6 JobReadyEvent — one per job
        var readyEvents = this.bus.Of<JobReadyEvent>();
        Assert.Equal(6, readyEvents.Count);
        foreach (var name in new[] { "root", "work1", "work2", "work3", "sv", "final" })
        {
            Assert.Contains(readyEvents, e => e.PlanId == planId && e.JobId == ids[name]);
        }

        // 2. Exactly 6 PhaseAttemptCompletedEvent — each AttemptNumber=1, Succeeded
        var attemptEvents = this.bus.Of<PhaseAttemptCompletedEvent>();
        Assert.Equal(6, attemptEvents.Count);
        Assert.All(attemptEvents, e =>
        {
            Assert.Equal(planId, e.PlanId);
            Assert.Equal(1, e.Attempt.AttemptNumber);
            Assert.Equal(JobStatus.Succeeded, e.Attempt.Status);
        });

        // 3. No JobBlockedEvent (nothing failed)
        var blockedEvents = this.bus.Of<JobBlockedEvent>();
        Assert.Empty(blockedEvents);

        // 4. Event ordering: Root before Work1/2/3, Work1/2/3 before SV, SV before Final
        var all = this.bus.All;
        int lastIdx(JobId id) => LastIndexForJob(all, id);
        int firstIdx(JobId id) => FirstIndexForJob(all, id);

        Assert.True(lastIdx(ids["root"]) < firstIdx(ids["work1"]),
            "Root's last event should precede Work1's first event");
        Assert.True(lastIdx(ids["root"]) < firstIdx(ids["work2"]),
            "Root's last event should precede Work2's first event");
        Assert.True(lastIdx(ids["root"]) < firstIdx(ids["work3"]),
            "Root's last event should precede Work3's first event");

        // All Work jobs finish before SV starts
        Assert.True(lastIdx(ids["work1"]) < firstIdx(ids["sv"]),
            "Work1 should complete before SV starts");
        Assert.True(lastIdx(ids["work2"]) < firstIdx(ids["sv"]),
            "Work2 should complete before SV starts");
        Assert.True(lastIdx(ids["work3"]) < firstIdx(ids["sv"]),
            "Work3 should complete before SV starts");

        // SV finishes before Final starts
        Assert.True(lastIdx(ids["sv"]) < firstIdx(ids["final"]),
            "SV should complete before Final starts");

        // 5. JobStatusChangedEvent: 4 transitions per job × 6 jobs = 24
        //    Each job: Pending→Ready, Ready→Scheduled, Scheduled→Running, Running→Succeeded
        var jobStatusEvents = this.bus.Of<JobStatusChangedEvent>();
        Assert.Equal(24, jobStatusEvents.Count);

        foreach (var name in new[] { "root", "work1", "work2", "work3", "sv", "final" })
        {
            var forJob = jobStatusEvents.Where(e => e.JobId == ids[name]).ToList();
            Assert.Equal(4, forJob.Count);
            Assert.Contains(forJob, e => e.PreviousStatus == JobStatus.Pending && e.NewStatus == JobStatus.Ready);
            Assert.Contains(forJob, e => e.PreviousStatus == JobStatus.Ready && e.NewStatus == JobStatus.Scheduled);
            Assert.Contains(forJob, e => e.PreviousStatus == JobStatus.Scheduled && e.NewStatus == JobStatus.Running);
            Assert.Contains(forJob, e => e.PreviousStatus == JobStatus.Running && e.NewStatus == JobStatus.Succeeded);
        }

        // 6. PlanStatusChangedEvent: Running → Succeeded
        var planStatusEvents = this.bus.Of<PlanStatusChangedEvent>();
        Assert.Single(planStatusEvents);
        Assert.Equal(PlanStatus.Running, planStatusEvents[0].PreviousStatus);
        Assert.Equal(PlanStatus.Succeeded, planStatusEvents[0].NewStatus);

        // ════════════════════════════════════════════════════════════
        // GIT / FILE ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 5. All 6 files on main
        Assert.True(fixture.VerifyFileOnBranch("main", "root.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "work1.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "work2.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "work3.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "verified.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "final.txt"));

        // 6. File content validation
        Assert.Equal("Output from Root", fixture.ReadFileOnBranch("main", "root.txt"));
        Assert.Equal("Output from Final", fixture.ReadFileOnBranch("main", "final.txt"));

        // ════════════════════════════════════════════════════════════
        // PLAN STATE ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 8. Plan status = Succeeded
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Succeeded, plan!.Status);

        // 9. All 6 jobs Succeeded
        Assert.Equal(6, plan.Jobs.Count);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // 10. Each job has exactly 1 attempt
        Assert.All(plan.Jobs.Values, j => Assert.Equal(1, j.Attempts.Count));

        // 11. SV node's DependsOn = [Work1, Work2, Work3]
        var svFinal = plan.Jobs[ids.Key("sv")];
        Assert.Equal(3, svFinal.DependsOn.Count);
        Assert.Contains(ids.Key("work1"), svFinal.DependsOn);
        Assert.Contains(ids.Key("work2"), svFinal.DependsOn);
        Assert.Contains(ids.Key("work3"), svFinal.DependsOn);

        // 12. Final's DependsOn = [SV]
        var finalNode = plan.Jobs[ids.Key("final")];
        Assert.Single(finalNode.DependsOn);
        Assert.Equal(ids.Key("sv"), finalNode.DependsOn[0]);
    }

    // ══════════════════════════════════════════════════════════════════
    // Test 2: Partial failure with blocked cascade
    // ══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Exercises a partial failure scenario: <c>A → B → C → D</c>.
    /// A succeeds. B fails (RemoteRejected). C and D are blocked by
    /// <see cref="PlanCompletionHandler"/>.
    ///
    /// Validates:
    /// <list type="bullet">
    /// <item><see cref="JobReadyEvent"/>: 1 for A (initial), 1 for B (after A)</item>
    /// <item><see cref="PhaseAttemptCompletedEvent"/>: 1 for A (Succeeded), 1 for B (Failed)</item>
    /// <item><see cref="JobBlockedEvent"/>: 1 for C (blocked by B), 1 for D (blocked by C — transitive)</item>
    /// <item>a.txt IS on main (A merged), no b.txt/c.txt/d.txt</item>
    /// <item>Plan status = Partial (mix of succeeded and failed/blocked)</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("FULL-PIPELINE-PARTIAL-FAILURE")]
    public async Task FULL_PIPELINE_PartialFailure_BlockedCascade_EventsValidated()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "full-pipeline-partial", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C → D
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);
        await AddJob(store, planId, ids.Register("d"), "Job D", ids["c"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("a")] = ("a.txt", "Output from A"),
            [ids.Key("b")] = ("b.txt", "Output from B"),
            [ids.Key("c")] = ("c.txt", "Output from C"),
            [ids.Key("d")] = ("d.txt", "Output from D"),
        };

        // A succeeds with real git
        var successExec = this.MakeGitExecutor(store, fixture, fileMap);
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);

        fixture.CreateWorktree(ids.Key("a"));
        var resultA = await this.ExecuteJobWithEvents(store, successExec, planId, ids["a"]);
        Assert.Equal(JobStatus.Succeeded, resultA.FinalStatus);
        fixture.MergeWorktreeToMain(ids.Key("a"));
        await handler.ProcessAsync(planId, CancellationToken.None);

        // B fails with RemoteRejected
        var failExec = this.MakeFailingGitExecutor(store, fixture, fileMap, ids.Key("b"));

        fixture.CreateWorktree(ids.Key("b"));
        var resultB = await this.ExecuteJobWithEvents(store, failExec, planId, ids["b"]);
        Assert.Equal(JobStatus.Failed, resultB.FinalStatus);
        // B's worktree is NOT merged to main

        // PlanCompletionHandler cascades Blocked to C and D, derives plan status
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        // ════════════════════════════════════════════════════════════
        // EVENT ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 1. JobReadyEvent: 1 for A, 1 for B, NONE for C/D
        var readyEvents = this.bus.Of<JobReadyEvent>();
        Assert.Equal(2, readyEvents.Count);
        Assert.Contains(readyEvents, e => e.JobId == ids["a"]);
        Assert.Contains(readyEvents, e => e.JobId == ids["b"]);
        Assert.DoesNotContain(readyEvents, e => e.JobId == ids["c"]);
        Assert.DoesNotContain(readyEvents, e => e.JobId == ids["d"]);

        // 2. PhaseAttemptCompletedEvent: 1 for A (Succeeded), 1 for B (Failed)
        var attemptEvents = this.bus.Of<PhaseAttemptCompletedEvent>();
        Assert.Equal(2, attemptEvents.Count);

        var attemptA = attemptEvents.Single(e => e.JobId == ids["a"]);
        Assert.Equal(JobStatus.Succeeded, attemptA.Attempt.Status);

        var attemptB = attemptEvents.Single(e => e.JobId == ids["b"]);
        Assert.Equal(JobStatus.Failed, attemptB.Attempt.Status);

        // 3. JobBlockedEvent: 1 for C (by B), 1 for D (by C — transitive)
        var blockedEvents = this.bus.Of<JobBlockedEvent>();
        Assert.Equal(2, blockedEvents.Count);

        var blockedC = blockedEvents.Single(e => e.JobId == ids["c"]);
        Assert.Equal(ids["b"], blockedC.BlockedBy);

        var blockedD = blockedEvents.Single(e => e.JobId == ids["d"]);
        Assert.Equal(ids["c"], blockedD.BlockedBy);

        // 4. JobStatusChangedEvent: A(4) + B(4) + C(1) + D(1) = 10
        var jobStatusEvents = this.bus.Of<JobStatusChangedEvent>();
        Assert.Equal(10, jobStatusEvents.Count);

        // A: Pending→Ready→Scheduled→Running→Succeeded
        var forA = jobStatusEvents.Where(e => e.JobId == ids["a"]).ToList();
        Assert.Equal(4, forA.Count);
        Assert.Contains(forA, e => e.PreviousStatus == JobStatus.Pending && e.NewStatus == JobStatus.Ready);
        Assert.Contains(forA, e => e.PreviousStatus == JobStatus.Ready && e.NewStatus == JobStatus.Scheduled);
        Assert.Contains(forA, e => e.PreviousStatus == JobStatus.Scheduled && e.NewStatus == JobStatus.Running);
        Assert.Contains(forA, e => e.PreviousStatus == JobStatus.Running && e.NewStatus == JobStatus.Succeeded);

        // B: Pending→Ready→Scheduled→Running→Failed
        var forB = jobStatusEvents.Where(e => e.JobId == ids["b"]).ToList();
        Assert.Equal(4, forB.Count);
        Assert.Contains(forB, e => e.PreviousStatus == JobStatus.Pending && e.NewStatus == JobStatus.Ready);
        Assert.Contains(forB, e => e.PreviousStatus == JobStatus.Ready && e.NewStatus == JobStatus.Scheduled);
        Assert.Contains(forB, e => e.PreviousStatus == JobStatus.Scheduled && e.NewStatus == JobStatus.Running);
        Assert.Contains(forB, e => e.PreviousStatus == JobStatus.Running && e.NewStatus == JobStatus.Failed);

        // C: Pending→Blocked
        var forC = jobStatusEvents.Where(e => e.JobId == ids["c"]).ToList();
        Assert.Single(forC);
        Assert.Equal(JobStatus.Pending, forC[0].PreviousStatus);
        Assert.Equal(JobStatus.Blocked, forC[0].NewStatus);

        // D: Pending→Blocked
        var forD = jobStatusEvents.Where(e => e.JobId == ids["d"]).ToList();
        Assert.Single(forD);
        Assert.Equal(JobStatus.Pending, forD[0].PreviousStatus);
        Assert.Equal(JobStatus.Blocked, forD[0].NewStatus);

        // 5. PlanStatusChangedEvent: Running → Partial
        var planStatusEvents = this.bus.Of<PlanStatusChangedEvent>();
        Assert.Single(planStatusEvents);
        Assert.Equal(PlanStatus.Running, planStatusEvents[0].PreviousStatus);
        Assert.Equal(PlanStatus.Partial, planStatusEvents[0].NewStatus);

        // ════════════════════════════════════════════════════════════
        // GIT ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 5. a.txt IS on main (A merged)
        Assert.True(fixture.VerifyFileOnBranch("main", "a.txt"));

        // 6. No b.txt, c.txt, d.txt on main
        Assert.False(fixture.VerifyFileOnBranch("main", "b.txt"));
        Assert.False(fixture.VerifyFileOnBranch("main", "c.txt"));
        Assert.False(fixture.VerifyFileOnBranch("main", "d.txt"));

        // ════════════════════════════════════════════════════════════
        // PLAN STATE ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // Plan status = Partial (A succeeded + B failed + C/D blocked)
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Partial, plan!.Status);

        Assert.Equal(JobStatus.Succeeded, plan.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Failed, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("c")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("d")].Status);
    }

    // ══════════════════════════════════════════════════════════════════
    // Test 3: Auto-heal event sequence
    // ══════════════════════════════════════════════════════════════════

    /// <summary>
    /// Single job. Work phase fails once (AgentNonZeroExit), succeeds on auto-heal.
    ///
    /// Validates:
    /// <list type="bullet">
    /// <item><see cref="PhaseAttemptCompletedEvent"/>: 2 emitted — first Failed, second Succeeded</item>
    /// <item>First attempt's <see cref="JobAttempt.Status"/> = Failed with error message</item>
    /// <item>Second attempt's <see cref="JobAttempt.Status"/> = Succeeded, AttemptNumber=2</item>
    /// <item>Job ends Succeeded with 2 attempts in store</item>
    /// <item>File exists on main after heal succeeds</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("FULL-PIPELINE-AUTOHEAL")]
    public async Task FULL_PIPELINE_AutoHeal_EventSequence()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "full-pipeline-autoheal", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("healer"), "Healable Job");

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("healer")] = ("healed.txt", "Output from healed job"),
        };

        // Work runner: fails on first call (AgentNonZeroExit), succeeds on second
        var workRunner = new HealableWorkPhaseRunner(fixture, fileMap);
        var exec = this.MakeGitExecutorWithCustomWork(store, fixture, workRunner, autoHeal: _ => true);

        fixture.CreateWorktree(ids.Key("healer"));
        var result = await this.ExecuteJobWithEvents(store, exec, planId, ids["healer"]);
        Assert.Equal(JobStatus.Succeeded, result.FinalStatus);
        Assert.Equal(2, result.AttemptCount);

        fixture.MergeWorktreeToMain(ids.Key("healer"));

        // ════════════════════════════════════════════════════════════
        // EVENT ASSERTIONS
        // ════════════════════════════════════════════════════════════

        // 1. PhaseAttemptCompletedEvent: 2 emitted — first Failed, second Succeeded
        var attemptEvents = this.bus.Of<PhaseAttemptCompletedEvent>();
        Assert.Equal(2, attemptEvents.Count);

        var first = attemptEvents[0];
        Assert.Equal(ids["healer"], first.JobId);
        Assert.Equal(JobStatus.Failed, first.Attempt.Status);
        Assert.Equal(1, first.Attempt.AttemptNumber);
        Assert.NotNull(first.Attempt.ErrorMessage);

        var second = attemptEvents[1];
        Assert.Equal(ids["healer"], second.JobId);
        Assert.Equal(JobStatus.Succeeded, second.Attempt.Status);
        Assert.Equal(2, second.Attempt.AttemptNumber);
        Assert.Null(second.Attempt.ErrorMessage);

        // 2. First attempt has phase timings showing Work phase failed
        Assert.True(first.Attempt.PhaseTimings.Count >= 1,
            "First attempt should have at least one phase timing entry");

        // 3. Exactly 1 JobReadyEvent (single job)
        var readyEvents = this.bus.Of<JobReadyEvent>();
        Assert.Single(readyEvents);
        Assert.Equal(ids["healer"], readyEvents[0].JobId);

        // 4. JobStatusChangedEvent: 6 transitions including Failed→Running heal
        //    Pending→Ready, Ready→Scheduled, Scheduled→Running,
        //    Running→Failed (heal), Failed→Running (heal retry), Running→Succeeded
        var jobStatusEvents = this.bus.Of<JobStatusChangedEvent>();
        Assert.Equal(6, jobStatusEvents.Count);

        var forHealer = jobStatusEvents.Where(e => e.JobId == ids["healer"]).ToList();
        Assert.Equal(6, forHealer.Count);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Pending && e.NewStatus == JobStatus.Ready);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Ready && e.NewStatus == JobStatus.Scheduled);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Scheduled && e.NewStatus == JobStatus.Running);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Running && e.NewStatus == JobStatus.Failed);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Failed && e.NewStatus == JobStatus.Running);
        Assert.Contains(forHealer, e => e.PreviousStatus == JobStatus.Running && e.NewStatus == JobStatus.Succeeded);

        // ════════════════════════════════════════════════════════════
        // GIT ASSERTIONS
        // ════════════════════════════════════════════════════════════

        Assert.True(fixture.VerifyFileOnBranch("main", "healed.txt"));
        Assert.Equal("Output from healed job", fixture.ReadFileOnBranch("main", "healed.txt"));

        // ════════════════════════════════════════════════════════════
        // PLAN STATE ASSERTIONS
        // ════════════════════════════════════════════════════════════

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);

        var job = plan!.Jobs[ids.Key("healer")];
        Assert.Equal(JobStatus.Succeeded, job.Status);
        Assert.Equal(2, job.Attempts.Count);
        Assert.Equal(JobStatus.Failed, job.Attempts[0].Status);
        Assert.Equal(JobStatus.Succeeded, job.Attempts[1].Status);
    }

    // ──────────────────────── Scheduler Loop Helpers ────────────────────────

    /// <summary>
    /// Drives the scheduler loop for a single job: publishes <see cref="JobReadyEvent"/>
    /// and <see cref="JobScheduledEvent"/>, transitions through Ready → Scheduled → Running,
    /// executes via <see cref="PhaseExecutor"/>, then transitions to the final status.
    /// This mirrors what the real <c>PlanScheduler</c> does.
    /// </summary>
    private async Task<PhaseExecResult> ExecuteJobWithEvents(
        PlanStore store, PhaseExecutor exec, PlanId planId, JobId jobId)
    {
        var key = jobId.ToString();
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var node = plan!.Jobs[key];

        // Parse predecessor JobIds for the event
        var predecessors = node.DependsOn
            .Select(d => JobId.TryParse(d, out var id) ? id : default)
            .Where(id => id != default)
            .ToImmutableArray();

        // Pending → Ready
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, key, JobStatus.Ready));
        await this.bus.PublishAsync(
            new JobReadyEvent
            {
                PlanId = planId,
                JobId = jobId,
                Predecessors = predecessors,
                At = this.clock.UtcNow,
            },
            CancellationToken.None);

        // Ready → Scheduled
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, key, JobStatus.Scheduled));
        await this.bus.PublishAsync(
            new JobScheduledEvent
            {
                PlanId = planId,
                JobId = jobId,
                At = this.clock.UtcNow,
            },
            CancellationToken.None);

        // Scheduled → Running
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, key, JobStatus.Running));

        // Execute the phase pipeline (PhaseExecutor publishes PhaseAttemptCompletedEvent)
        var result = await exec.ExecuteAsync(planId, jobId, RunId.New(), CancellationToken.None);

        // Running → final status
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, key, result.FinalStatus));

        return result;
    }

    // ──────────────────────── Event Ordering Helpers ────────────────────────

    /// <summary>Extracts the <see cref="JobId"/> from any known event type.</summary>
    private static JobId? GetEventJobId(object evt) => evt switch
    {
        JobReadyEvent e => e.JobId,
        JobScheduledEvent e => e.JobId,
        PhaseAttemptCompletedEvent e => e.JobId,
        JobBlockedEvent e => e.JobId,
        JobStatusChangedEvent e => e.JobId,
        _ => null,
    };

    /// <summary>Finds the index of the first event for the given job in the event list.</summary>
    private static int FirstIndexForJob(IReadOnlyList<object> events, JobId jobId)
    {
        for (int i = 0; i < events.Count; i++)
        {
            if (GetEventJobId(events[i]) is { } id && id == jobId)
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>Finds the index of the last event for the given job in the event list.</summary>
    private static int LastIndexForJob(IReadOnlyList<object> events, JobId jobId)
    {
        for (int i = events.Count - 1; i >= 0; i--)
        {
            if (GetEventJobId(events[i]) is { } id && id == jobId)
            {
                return i;
            }
        }

        return -1;
    }

    // ──────────────────────── Infrastructure Helpers ────────────────────────

    private PlanStore CreateStore(PlanStoreOptions? options = null) =>
        new(
            new AbsolutePath(this.storeRoot),
            new NullFileSystem(),
            this.clock,
            this.bus,
            new FixedOptions<PlanStoreOptions>(options ?? new PlanStoreOptions()),
            NullLogger<PlanStore>.Instance);

    private PhaseExecutor MakeGitExecutor(
        PlanStore store,
        GitTestFixture fixture,
        Dictionary<string, (string FileName, string Content)> fileMap)
    {
        var runners = new IPhaseRunner[]
        {
            new FakePhaseRunner(JobPhase.MergeForwardIntegration),
            new FakePhaseRunner(JobPhase.Setup),
            new FakePhaseRunner(JobPhase.Prechecks),
            new RealWorkPhaseRunner(fixture, fileMap),
            new RealCommitPhaseRunner(fixture),
            new FakePhaseRunner(JobPhase.Postchecks),
            new FakePhaseRunner(JobPhase.MergeReverseIntegration),
        };
        return new PhaseExecutor(
            store,
            this.bus,
            this.clock,
            new FixedOptions<PhaseOptions>(new PhaseOptions()),
            NullLogger<PhaseExecutor>.Instance,
            runners);
    }

    private PhaseExecutor MakeFailingGitExecutor(
        PlanStore store,
        GitTestFixture fixture,
        Dictionary<string, (string FileName, string Content)> fileMap,
        string failJobKey)
    {
        var runners = new IPhaseRunner[]
        {
            new FakePhaseRunner(JobPhase.MergeForwardIntegration),
            new FakePhaseRunner(JobPhase.Setup),
            new FakePhaseRunner(JobPhase.Prechecks),
            new FailingWorkPhaseRunner(fixture, fileMap, failJobKey),
            new RealCommitPhaseRunner(fixture),
            new FakePhaseRunner(JobPhase.Postchecks),
            new FakePhaseRunner(JobPhase.MergeReverseIntegration),
        };
        return new PhaseExecutor(
            store,
            this.bus,
            this.clock,
            new FixedOptions<PhaseOptions>(new PhaseOptions()),
            NullLogger<PhaseExecutor>.Instance,
            runners);
    }

    private PhaseExecutor MakeGitExecutorWithCustomWork(
        PlanStore store,
        GitTestFixture fixture,
        IPhaseRunner workRunner,
        Func<JobNode, bool>? autoHeal = null)
    {
        var runners = new IPhaseRunner[]
        {
            new FakePhaseRunner(JobPhase.MergeForwardIntegration),
            new FakePhaseRunner(JobPhase.Setup),
            new FakePhaseRunner(JobPhase.Prechecks),
            workRunner,
            new RealCommitPhaseRunner(fixture),
            new FakePhaseRunner(JobPhase.Postchecks),
            new FakePhaseRunner(JobPhase.MergeReverseIntegration),
        };
        return new PhaseExecutor(
            store,
            this.bus,
            this.clock,
            new FixedOptions<PhaseOptions>(new PhaseOptions()),
            NullLogger<PhaseExecutor>.Instance,
            runners,
            autoHeal);
    }

    private static async Task<HashSet<string>> ComputeReadySet(PlanStore store, PlanId planId)
    {
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var ready = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (id, job) in plan!.Jobs)
        {
            if (job.Status != JobStatus.Pending)
            {
                continue;
            }

            if (job.DependsOn.Count == 0 ||
                job.DependsOn.All(d => plan.Jobs.TryGetValue(d, out var dep) &&
                    (dep.Status == JobStatus.Succeeded || dep.Status == JobStatus.Skipped)))
            {
                ready.Add(id);
            }
        }

        return ready;
    }

    private static Task AddJob(PlanStore store, PlanId planId, JobId jobId, string title, params JobId[] deps) =>
        Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = jobId.ToString(),
                Title = title,
                Status = JobStatus.Pending,
                DependsOn = deps.Select(d => d.ToString()).ToArray(),
            }));

    private static async Task Mutate(PlanStore store, PlanId planId, PlanMutation mutation) =>
        await store.MutateAsync(planId, mutation, Idem(), CancellationToken.None);

    private static IdempotencyKey Idem() => IdempotencyKey.FromGuid(Guid.NewGuid());

    private static void ForceDeleteDirectory(string path)
    {
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            try { File.SetAttributes(file, FileAttributes.Normal); }
            catch { /* ignore */ }
        }

        Directory.Delete(path, recursive: true);
    }

    // ──────────────────────── FullRecordingEventBus ────────────────────────

    /// <summary>
    /// Records all events published, in order, with support for both typed queries
    /// (<see cref="Of{T}"/>) and full ordered access (<see cref="All"/>).
    /// </summary>
    private sealed class FullRecordingEventBus : IEventBus
    {
        private readonly List<object> events = [];
        private readonly object syncRoot = new();

        /// <summary>Gets a snapshot of all events in publication order.</summary>
        public IReadOnlyList<object> All
        {
            get { lock (this.syncRoot) { return [.. this.events]; } }
        }

        /// <summary>Gets all events of a specific type, in publication order.</summary>
        public IReadOnlyList<T> Of<T>()
        {
            lock (this.syncRoot)
            {
                return this.events.OfType<T>().ToList();
            }
        }

        public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
            where TEvent : notnull
        {
            lock (this.syncRoot)
            {
                this.events.Add(eventData);
            }

            return ValueTask.CompletedTask;
        }

        public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
            where TEvent : notnull => NullSub.Instance;

        private sealed class NullSub : IAsyncDisposable
        {
            public static readonly NullSub Instance = new();

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    // ──────────────────────── Git Test Fixture ────────────────────────

    /// <summary>
    /// Manages a real git repository in a temp directory. Uses the <c>git</c> CLI for all
    /// operations including worktree management, commits, and merges.
    /// </summary>
    private sealed class GitTestFixture : IDisposable
    {
        private readonly string repoPath;
        private readonly Dictionary<string, string> worktreePaths = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> worktreeBranches = new(StringComparer.Ordinal);

        public GitTestFixture()
        {
            this.repoPath = Path.Combine(Path.GetTempPath(), "full-pipeline-git", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.repoPath);

            RunGit(this.repoPath, "init", "-b", "main");
            RunGit(this.repoPath, "config", "user.email", "test@test.com");
            RunGit(this.repoPath, "config", "user.name", "Test");

            var initFile = Path.Combine(this.repoPath, ".gitkeep");
            File.WriteAllText(initFile, "init");
            RunGit(this.repoPath, "add", ".");
            RunGit(this.repoPath, "commit", "-m", "Initial commit");
        }

        public void CreateWorktree(string jobKey)
        {
            var safeName = SanitizeBranchName(jobKey);
            var branchName = $"job/{safeName}";
            var worktreePath = Path.Combine(this.repoPath, ".worktrees", safeName);

            RunGit(this.repoPath, "worktree", "add", worktreePath, "-b", branchName);
            RunGit(worktreePath, "config", "user.email", "test@test.com");
            RunGit(worktreePath, "config", "user.name", "Test");

            this.worktreePaths[jobKey] = worktreePath;
            this.worktreeBranches[jobKey] = branchName;
        }

        public string GetWorktreePath(string jobKey) =>
            this.worktreePaths.TryGetValue(jobKey, out var path)
                ? path
                : throw new InvalidOperationException($"No worktree for job '{jobKey}'");

        public void WriteFile(string jobKey, string filename, string content)
        {
            var wtPath = this.GetWorktreePath(jobKey);
            var filePath = Path.Combine(wtPath, filename);
            var dir = Path.GetDirectoryName(filePath);
            if (dir is not null && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(filePath, content);
        }

        public void StageAll(string jobKey)
        {
            var wtPath = this.GetWorktreePath(jobKey);
            RunGit(wtPath, "add", ".");
        }

        public string CommitInWorktree(string jobKey, string message)
        {
            var wtPath = this.GetWorktreePath(jobKey);
            RunGit(wtPath, "commit", "-m", message, "--allow-empty");
            return RunGit(wtPath, "rev-parse", "HEAD").Trim();
        }

        public void MergeWorktreeToMain(string jobKey)
        {
            var branchName = this.worktreeBranches.TryGetValue(jobKey, out var b)
                ? b
                : throw new InvalidOperationException($"No worktree branch for '{jobKey}'");

            RunGit(this.repoPath, "checkout", "main");
            RunGit(this.repoPath, "merge", branchName, "--no-ff", "-m", $"Merge {branchName}");
        }

        public bool VerifyFileOnBranch(string branch, string filename)
        {
            try
            {
                RunGit(this.repoPath, "show", $"{branch}:{filename}");
                return true;
            }
            catch
            {
                return false;
            }
        }

        public string ReadFileOnBranch(string branch, string filename) =>
            RunGit(this.repoPath, "show", $"{branch}:{filename}").TrimEnd('\r', '\n');

        public void Dispose()
        {
            try
            {
                foreach (var (_, wtPath) in this.worktreePaths)
                {
                    try { RunGit(this.repoPath, "worktree", "remove", wtPath, "--force"); }
                    catch { /* best-effort */ }
                }

                if (Directory.Exists(this.repoPath))
                {
                    ForceDeleteDirectory(this.repoPath);
                }
            }
            catch
            {
                // best-effort cleanup
            }
        }

        private static string SanitizeBranchName(string key) =>
            key.Replace("/", "-").Replace("\\", "-");

        private static string RunGit(string workDir, params string[] args)
        {
            var psi = new System.Diagnostics.ProcessStartInfo("git")
            {
                WorkingDirectory = workDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in args)
            {
                psi.ArgumentList.Add(arg);
            }

            using var process = System.Diagnostics.Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start git process");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"git {string.Join(' ', args)} failed (exit {process.ExitCode}) in {workDir}: {stderr}");
            }

            return stdout;
        }
    }

    // ──────────────────────── Real Phase Runners ────────────────────────

    /// <summary>Writes a file in the job's worktree and stages it.</summary>
    private sealed class RealWorkPhaseRunner : IPhaseRunner
    {
        private readonly GitTestFixture fixture;
        private readonly Dictionary<string, (string FileName, string Content)> fileMap;

        public RealWorkPhaseRunner(
            GitTestFixture fixture,
            Dictionary<string, (string FileName, string Content)> fileMap)
        {
            this.fixture = fixture;
            this.fileMap = fileMap;
        }

        public JobPhase Phase => JobPhase.Work;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            if (this.fileMap.TryGetValue(key, out var entry))
            {
                this.fixture.WriteFile(key, entry.FileName, entry.Content);
                this.fixture.StageAll(key);
            }

            return new ValueTask<CommitSha?>((CommitSha?)null);
        }
    }

    /// <summary>Commits staged changes in the job's worktree.</summary>
    private sealed class RealCommitPhaseRunner : IPhaseRunner
    {
        private readonly GitTestFixture fixture;

        public RealCommitPhaseRunner(GitTestFixture fixture) => this.fixture = fixture;

        public JobPhase Phase => JobPhase.Commit;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            var sha = this.fixture.CommitInWorktree(key, $"Job {key}");
            return new ValueTask<CommitSha?>(new CommitSha(sha));
        }
    }

    /// <summary>
    /// Writes files normally but throws <see cref="PhaseExecutionException"/> for a
    /// specific job, simulating a failed work phase.
    /// </summary>
    private sealed class FailingWorkPhaseRunner : IPhaseRunner
    {
        private readonly GitTestFixture fixture;
        private readonly Dictionary<string, (string FileName, string Content)> fileMap;
        private readonly string failJobKey;

        public FailingWorkPhaseRunner(
            GitTestFixture fixture,
            Dictionary<string, (string FileName, string Content)> fileMap,
            string failJobKey)
        {
            this.fixture = fixture;
            this.fileMap = fileMap;
            this.failJobKey = failJobKey;
        }

        public JobPhase Phase => JobPhase.Work;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            if (this.fileMap.TryGetValue(key, out var entry))
            {
                this.fixture.WriteFile(key, entry.FileName, entry.Content);
                this.fixture.StageAll(key);
            }

            if (string.Equals(key, this.failJobKey, StringComparison.Ordinal))
            {
                throw new PhaseExecutionException(
                    PhaseFailureKind.RemoteRejected,
                    JobPhase.Work,
                    $"Simulated failure for job {key}");
            }

            return new ValueTask<CommitSha?>((CommitSha?)null);
        }
    }

    /// <summary>
    /// Work-phase runner that writes a file and stages it, but fails on the first call
    /// with <see cref="PhaseFailureKind.AgentNonZeroExit"/> to exercise the auto-heal path.
    /// Succeeds on all subsequent calls.
    /// </summary>
    private sealed class HealableWorkPhaseRunner : IPhaseRunner
    {
        private readonly GitTestFixture fixture;
        private readonly Dictionary<string, (string FileName, string Content)> fileMap;
        private int callCount;

        public HealableWorkPhaseRunner(
            GitTestFixture fixture,
            Dictionary<string, (string FileName, string Content)> fileMap)
        {
            this.fixture = fixture;
            this.fileMap = fileMap;
        }

        public JobPhase Phase => JobPhase.Work;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            if (this.fileMap.TryGetValue(key, out var entry))
            {
                this.fixture.WriteFile(key, entry.FileName, entry.Content);
                this.fixture.StageAll(key);
            }

            var n = Interlocked.Increment(ref this.callCount);
            if (n == 1)
            {
                throw new PhaseExecutionException(
                    PhaseFailureKind.AgentNonZeroExit,
                    JobPhase.Work,
                    "Agent died on first attempt");
            }

            return new ValueTask<CommitSha?>((CommitSha?)null);
        }
    }

    // ──────────────────────── Shared Inner Types ────────────────────────

    /// <summary>Maps friendly test names to real <see cref="JobId"/> values.</summary>
    private sealed class JobIdMap
    {
        private readonly Dictionary<string, JobId> map = new(StringComparer.Ordinal);

        public JobId Register(string name)
        {
            var id = JobId.New();
            this.map[name] = id;
            return id;
        }

        public JobId this[string name] => this.map[name];

        public string Key(string name) => this.map[name].ToString();
    }

    /// <summary>Minimal <see cref="IFileSystem"/> for PlanStore (journal/checkpoint I/O).</summary>
    private sealed class NullFileSystem : IFileSystem
    {
        public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(false);

        public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) => new(string.Empty);

        public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) => default;

        public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) => new((Stream)new MemoryStream());

        public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) =>
            new((Stream)new MemoryStream());

        public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct) => default;

        public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;

        public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);
    }
}
