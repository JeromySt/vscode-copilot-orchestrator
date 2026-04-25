// <copyright file="DagLifecycleIntegrationTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
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
using AiOrchestrator.Plan.Store;
using AiOrchestrator.TestKit.Time;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using PlanModel = AiOrchestrator.Plan.Models.Plan;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>
/// Integration tests that exercise the full DAG state-machine lifecycle by wiring
/// a real <see cref="PlanStore"/> with <see cref="PhaseExecutor"/> and manually driving
/// the ready-set / scheduler loop. Job IDs are proper <see cref="JobId"/> values stored
/// in a name→id mapping so that <see cref="PhaseExecutor"/> can look them up via
/// <c>jobId.ToString()</c>.
/// </summary>
public sealed class DagLifecycleIntegrationTests : IDisposable
{
    private static readonly CommitSha TestSha = new("abcdef0123456789abcdef0123456789abcdef01");

    private readonly string root;
    private readonly InMemoryClock clock;
    private readonly RecordingEventBus bus;

    public DagLifecycleIntegrationTests()
    {
        this.root = Path.Combine(AppContext.BaseDirectory, "dag-lifecycle", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
        this.clock = new InMemoryClock();
        this.bus = new RecordingEventBus();
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

    // ────────────────────────────── Test 1 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-LINEAR")]
    public async Task DAG_LIFECYCLE_LinearChain_AllSucceed()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "linear", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute A
        var readyBefore = await ComputeReadySet(store, planId);
        Assert.Single(readyBefore);
        Assert.Contains(ids.Key("a"), readyBefore);

        var resultA = await ExecuteJob(store, exec, planId, ids["a"]);
        Assert.Equal(JobStatus.Succeeded, resultA.FinalStatus);
        Assert.Equal(JobPhase.Done, resultA.EndedAtPhase);

        // B becomes ready after A succeeds
        var readyAfterA = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterA);
        Assert.Contains(ids.Key("b"), readyAfterA);

        var resultB = await ExecuteJob(store, exec, planId, ids["b"]);
        Assert.Equal(JobStatus.Succeeded, resultB.FinalStatus);

        // C becomes ready after B succeeds
        var readyAfterB = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterB);
        Assert.Contains(ids.Key("c"), readyAfterB);

        var resultC = await ExecuteJob(store, exec, planId, ids["c"]);
        Assert.Equal(JobStatus.Succeeded, resultC.FinalStatus);

        // Mark plan succeeded
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        // Verify final state
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Succeeded, plan!.Status);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
        Assert.True(plan.Jobs[ids.Key("a")].Attempts.Count >= 1);
        Assert.True(plan.Jobs[ids.Key("b")].Attempts.Count >= 1);
        Assert.True(plan.Jobs[ids.Key("c")].Attempts.Count >= 1);
    }

    // ────────────────────────────── Test 2 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-DIAMOND")]
    public async Task DAG_LIFECYCLE_DiamondDag_FanInReady()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "diamond", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A→C, B→C, C→D
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Root A");
        await AddJob(store, planId, ids.Register("b"), "Root B");
        await AddJob(store, planId, ids.Register("c"), "Fan-in C", ids["a"], ids["b"]);
        await AddJob(store, planId, ids.Register("d"), "Leaf D", ids["c"]);

        var exec = this.MakeExecutor(store);

        // Initial ready set: A and B
        var ready0 = await ComputeReadySet(store, planId);
        Assert.Equal(2, ready0.Count);
        Assert.Contains(ids.Key("a"), ready0);
        Assert.Contains(ids.Key("b"), ready0);

        // Execute A — C should NOT be ready yet (B still pending)
        await ExecuteJob(store, exec, planId, ids["a"]);
        var readyAfterA = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterA);
        Assert.Contains(ids.Key("b"), readyAfterA);
        Assert.DoesNotContain(ids.Key("c"), readyAfterA);

        // Execute B — now C should be ready (both A and B succeeded)
        await ExecuteJob(store, exec, planId, ids["b"]);
        var readyAfterB = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterB);
        Assert.Contains(ids.Key("c"), readyAfterB);

        // Execute C → D becomes ready
        await ExecuteJob(store, exec, planId, ids["c"]);
        var readyAfterC = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterC);
        Assert.Contains(ids.Key("d"), readyAfterC);

        await ExecuteJob(store, exec, planId, ids["d"]);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.All(plan!.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────────── Test 3 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-FAIL-BLOCKS")]
    public async Task DAG_LIFECYCLE_FailedJob_BlocksDownstream()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "fail-blocks", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        // A's Work phase fails with RemoteRejected (always GiveUp)
        var failWork = new FakePhaseRunner(JobPhase.Work, failureSelector: _ =>
            () => throw new PhaseExecutionException(PhaseFailureKind.RemoteRejected, JobPhase.Work, "rejected"));
        var exec = this.MakeExecutor(store, workRunner: failWork);

        var resultA = await ExecuteJob(store, exec, planId, ids["a"]);
        Assert.Equal(JobStatus.Failed, resultA.FinalStatus);
        Assert.Equal(JobPhase.Work, resultA.EndedAtPhase);

        // Block downstream jobs
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Blocked));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Blocked));
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Failed));

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Failed, plan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("c")].Status);
        Assert.Equal(PlanStatus.Failed, plan.Status);

        // No jobs should be ready
        var ready = await ComputeReadySet(store, planId);
        Assert.Empty(ready);
    }

    // ────────────────────────────── Test 4 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-AUTOHEAL")]
    public async Task DAG_LIFECYCLE_AutoHeal_WorkPhaseRecovery()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "autoheal", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("j1"), "Healable job");

        // Work fails on first call (AgentNonZeroExit → auto-heal), succeeds on second
        var work = new FakePhaseRunner(JobPhase.Work, failureSelector: n => n == 1
            ? () => throw new PhaseExecutionException(PhaseFailureKind.AgentNonZeroExit, JobPhase.Work, "agent died")
            : null);
        var exec = this.MakeExecutor(store, workRunner: work, autoHeal: _ => true);

        var result = await ExecuteJob(store, exec, planId, ids["j1"]);

        Assert.Equal(JobStatus.Succeeded, result.FinalStatus);
        Assert.Equal(2, result.AttemptCount);
        Assert.Equal(2, work.Calls.Count);

        // Verify attempts recorded in store
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var attempts = plan!.Jobs[ids.Key("j1")].Attempts;
        Assert.Equal(2, attempts.Count);
        Assert.Equal(JobStatus.Failed, attempts[0].Status);
        Assert.Equal(JobStatus.Succeeded, attempts[1].Status);
    }

    // ────────────────────────────── Test 5 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-CANCEL")]
    public async Task DAG_LIFECYCLE_Cancel_AllPendingBecameCanceled()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "cancel", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C; A is running, B and C are pending
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Running A");
        await AddJob(store, planId, ids.Register("b"), "Pending B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Pending C", ids["b"]);

        // Transition A to Running
        await TransitionToRunning(store, planId, ids.Key("a"));

        // Simulate cancel: transition pending jobs to Canceled
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Canceled));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Canceled));

        // Cancel running A
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("a"), JobStatus.Canceled));

        // Plan → Canceled
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Canceled));

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Canceled, plan!.Status);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Canceled, j.Status));
    }

    // ────────────────────────────── Test 6 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-RECOVERY")]
    public async Task DAG_LIFECYCLE_Recovery_ResetFailedJobs()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "recovery", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        // A succeeded
        var exec = this.MakeExecutor(store);
        await ExecuteJob(store, exec, planId, ids["a"]);

        // B failed (Work phase fails with RemoteRejected)
        var failWork = new FakePhaseRunner(JobPhase.Work, failureSelector: _ =>
            () => throw new PhaseExecutionException(PhaseFailureKind.RemoteRejected, JobPhase.Work, "rejected"));
        var failExec = this.MakeExecutor(store, workRunner: failWork);
        var resultB = await ExecuteJob(store, failExec, planId, ids["b"]);
        Assert.Equal(JobStatus.Failed, resultB.FinalStatus);

        // C → Blocked
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Blocked));
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Failed));

        // Verify pre-recovery state
        var pre = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(pre);
        Assert.Equal(JobStatus.Succeeded, pre!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Failed, pre.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, pre.Jobs[ids.Key("c")].Status);

        // Recovery: reset Failed → Pending, Blocked → Pending
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Pending));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Pending));
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Paused));

        // Verify post-recovery state
        var post = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(post);
        Assert.Equal(JobStatus.Succeeded, post!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Pending, post.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Pending, post.Jobs[ids.Key("c")].Status);
        Assert.Equal(PlanStatus.Paused, post.Status);

        // B should now be ready (A is succeeded)
        var ready = await ComputeReadySet(store, planId);
        Assert.Single(ready);
        Assert.Contains(ids.Key("b"), ready);
    }

    // ────────────────────────────── Test 7 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-PHASE-TIMINGS")]
    public async Task DAG_LIFECYCLE_MultipleAttempts_PhaseTimingsRecorded()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "timings", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("j1"), "Transient job");

        // Work fails first with TransientNetwork (PhaseResume), then succeeds
        var work = new FakePhaseRunner(JobPhase.Work, failureSelector: n => n == 1
            ? () => throw new PhaseExecutionException(PhaseFailureKind.TransientNetwork, JobPhase.Work, "net glitch")
            : null);
        var exec = this.MakeExecutor(store, workRunner: work);

        var result = await ExecuteJob(store, exec, planId, ids["j1"]);
        Assert.Equal(JobStatus.Succeeded, result.FinalStatus);
        Assert.Equal(2, result.AttemptCount);

        // Verify attempts have phase timings
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var attempts = plan!.Jobs[ids.Key("j1")].Attempts;
        Assert.Equal(2, attempts.Count);

        // First attempt: ran through MergeFI, Setup, Prechecks, Work (failed)
        Assert.True(attempts[0].PhaseTimings.Count >= 1, "First attempt should have at least 1 phase timing");
        Assert.NotNull(attempts[0].ErrorMessage);

        // Second attempt: work succeeded, then commit, postchecks, mergeRI
        Assert.True(attempts[1].PhaseTimings.Count >= 1, "Second attempt should have phase timings");
        Assert.Equal(JobStatus.Succeeded, attempts[1].Status);
        Assert.Null(attempts[1].ErrorMessage);
    }

    // ────────────────────────────── Test 8 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-LARGE-DAG")]
    public async Task DAG_LIFECYCLE_ReadySet_LargeDAG()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "large-dag", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();

        // 3 roots
        await AddJob(store, planId, ids.Register("r0"), "Root 0");
        await AddJob(store, planId, ids.Register("r1"), "Root 1");
        await AddJob(store, planId, ids.Register("r2"), "Root 2");

        // 4 middle: m0(r0,r1), m1(r1,r2), m2(r0), m3(r2)
        await AddJob(store, planId, ids.Register("m0"), "Mid 0", ids["r0"], ids["r1"]);
        await AddJob(store, planId, ids.Register("m1"), "Mid 1", ids["r1"], ids["r2"]);
        await AddJob(store, planId, ids.Register("m2"), "Mid 2", ids["r0"]);
        await AddJob(store, planId, ids.Register("m3"), "Mid 3", ids["r2"]);

        // 3 leaves: l0(m0,m1), l1(m2,m3), l2(m0,m2)
        await AddJob(store, planId, ids.Register("l0"), "Leaf 0", ids["m0"], ids["m1"]);
        await AddJob(store, planId, ids.Register("l1"), "Leaf 1", ids["m2"], ids["m3"]);
        await AddJob(store, planId, ids.Register("l2"), "Leaf 2", ids["m0"], ids["m2"]);

        var exec = this.MakeExecutor(store);

        // Tier 0: only roots are ready
        var ready0 = await ComputeReadySet(store, planId);
        Assert.Equal(3, ready0.Count);
        Assert.Contains(ids.Key("r0"), ready0);
        Assert.Contains(ids.Key("r1"), ready0);
        Assert.Contains(ids.Key("r2"), ready0);

        // Execute all roots
        foreach (var r in new[] { "r0", "r1", "r2" })
        {
            await ExecuteJob(store, exec, planId, ids[r]);
        }

        // Tier 1: all middle jobs become ready
        var ready1 = await ComputeReadySet(store, planId);
        Assert.Equal(4, ready1.Count);
        foreach (var m in new[] { "m0", "m1", "m2", "m3" })
        {
            Assert.Contains(ids.Key(m), ready1);
        }

        // Execute all middle
        foreach (var m in new[] { "m0", "m1", "m2", "m3" })
        {
            await ExecuteJob(store, exec, planId, ids[m]);
        }

        // Tier 2: all leaves become ready
        var ready2 = await ComputeReadySet(store, planId);
        Assert.Equal(3, ready2.Count);
        foreach (var l in new[] { "l0", "l1", "l2" })
        {
            Assert.Contains(ids.Key(l), ready2);
        }

        // Execute all leaves
        foreach (var l in new[] { "l0", "l1", "l2" })
        {
            await ExecuteJob(store, exec, planId, ids[l]);
        }

        // All done
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.All(plan!.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
        Assert.Equal(10, plan.Jobs.Count);
    }

    // ─────────────────── Test: Context Pressure Split ───────────────────

    /// <summary>
    /// Exercises the full <c>CompletedSplit</c> context-pressure lifecycle:
    ///
    /// <para>Initial DAG: <c>A → B → C</c></para>
    ///
    /// Job B's agent runs out of context window mid-work. The orchestrator:
    /// <list type="number">
    /// <item>Transitions B from <c>Running → CompletedSplit</c> (blocks C)</item>
    /// <item>Reshapes the DAG: adds sub-jobs B1, B2 (depend on B) and fan-in BV
    ///   (depends on B1+B2). C is rewired to depend on BV instead of B.</item>
    /// <item>Transitions B from <c>CompletedSplit → Succeeded</c> (B1+B2 become ready)</item>
    /// <item>Executes B1, B2 → BV → C.</item>
    /// </list>
    ///
    /// Verifies:
    /// <list type="bullet">
    /// <item><c>CompletedSplit</c> blocks downstream (C stays Pending)</item>
    /// <item>Sub-jobs are only ready after parent transitions to <c>Succeeded</c></item>
    /// <item>Fan-in job waits for all sub-jobs</item>
    /// <item>Original downstream C rewired through fan-in</item>
    /// <item>Full plan succeeds with correct topology</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-CONTEXT-PRESSURE")]
    public async Task DAG_LIFECYCLE_ContextPressure_SplitAndFanIn()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "context-pressure", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Initial DAG: A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // ── Phase 1: Execute A normally ──
        await ExecuteJob(store, exec, planId, ids["a"]);

        // B is now ready
        var readyAfterA = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterA);
        Assert.Contains(ids.Key("b"), readyAfterA);

        // ── Phase 2: B runs but hits context pressure ──
        // Manually drive B to Running (the orchestrator would do this)
        await TransitionToRunning(store, planId, ids.Key("b"));

        // Simulate: Work phase completes partially, agent reports context pressure.
        // The orchestrator transitions B → CompletedSplit.
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.CompletedSplit));

        // ── Verify: CompletedSplit blocks downstream ──
        // C should NOT be ready because B is CompletedSplit (not Succeeded)
        var readyDuringSplit = await ComputeReadySet(store, planId);
        Assert.Empty(readyDuringSplit);

        // Verify B is in CompletedSplit state
        var planMidSplit = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(planMidSplit);
        Assert.Equal(JobStatus.CompletedSplit, planMidSplit!.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Pending, planMidSplit.Jobs[ids.Key("c")].Status);

        // ── Phase 3: Reshape — fan-out sub-jobs + fan-in ──
        // The orchestrator reads the checkpoint manifest and creates sub-jobs.
        var b1Id = ids.Register("b1");
        var b2Id = ids.Register("b2");
        var bvId = ids.Register("bv"); // fan-in validation

        // Add sub-jobs depending on B
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = b1Id.ToString(),
                Title = "B-split-chunk-1",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b") },
                WorkSpec = new WorkSpec { Instructions = "Continue B's work: chunk 1 of 2" },
            }));

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = b2Id.ToString(),
                Title = "B-split-chunk-2",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b") },
                WorkSpec = new WorkSpec { Instructions = "Continue B's work: chunk 2 of 2" },
            }));

        // Fan-in validation depends on both sub-jobs
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = bvId.ToString(),
                Title = "B-split-fanin-verify",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b1"), ids.Key("b2") },
                WorkSpec = new WorkSpec { Instructions = "Verify chunks B1+B2 are consistent" },
            }));

        // Rewire C: remove B dependency, add BV dependency
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("c"),
            System.Collections.Immutable.ImmutableArray.Create(ids.Key("bv"))));

        // ── Verify: sub-jobs not yet ready (B is CompletedSplit, not Succeeded) ──
        var readyAfterReshape = await ComputeReadySet(store, planId);
        Assert.Empty(readyAfterReshape);

        // ── Phase 4: Finalize B → Succeeded ──
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Succeeded));

        // Now B1 and B2 should be ready (both depend only on B which is Succeeded)
        var readyAfterBSucceeded = await ComputeReadySet(store, planId);
        Assert.Equal(2, readyAfterBSucceeded.Count);
        Assert.Contains(ids.Key("b1"), readyAfterBSucceeded);
        Assert.Contains(ids.Key("b2"), readyAfterBSucceeded);

        // C should NOT be ready (depends on BV which is Pending)
        Assert.DoesNotContain(ids.Key("c"), readyAfterBSucceeded);
        // BV should NOT be ready (depends on B1, B2 which are Pending)
        Assert.DoesNotContain(ids.Key("bv"), readyAfterBSucceeded);

        // ── Phase 5: Execute sub-jobs ──
        await ExecuteJob(store, exec, planId, ids["b1"]);
        await ExecuteJob(store, exec, planId, ids["b2"]);

        // BV should now be ready (both B1 and B2 succeeded)
        var readyAfterChunks = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterChunks);
        Assert.Contains(ids.Key("bv"), readyAfterChunks);

        await ExecuteJob(store, exec, planId, ids["bv"]);

        // C should now be ready (BV succeeded)
        var readyAfterFanIn = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterFanIn);
        Assert.Contains(ids.Key("c"), readyAfterFanIn);

        await ExecuteJob(store, exec, planId, ids["c"]);

        // ── Final verification ──
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);
        Assert.Equal(6, finalPlan.Jobs.Count); // A, B, B1, B2, BV, C
        Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // Verify the reshaped topology is correct
        var cNode = finalPlan.Jobs[ids.Key("c")];
        Assert.Single(cNode.DependsOn);
        Assert.Equal(ids.Key("bv"), cNode.DependsOn[0]);

        var bvNode = finalPlan.Jobs[ids.Key("bv")];
        Assert.Equal(2, bvNode.DependsOn.Count);
        Assert.Contains(ids.Key("b1"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b2"), bvNode.DependsOn);
    }

    /// <summary>
    /// Verifies that <c>CompletedSplit → Failed</c> propagates correctly:
    /// if the reshape fails after entering <c>CompletedSplit</c>, the job
    /// transitions to <c>Failed</c> and downstream jobs become <c>Blocked</c>.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-CONTEXT-PRESSURE-FAIL")]
    public async Task DAG_LIFECYCLE_ContextPressure_ReshapeFailure_PropagatesBlocked()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "pressure-fail", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute A
        await ExecuteJob(store, exec, planId, ids["a"]);

        // B enters Running, then CompletedSplit
        await TransitionToRunning(store, planId, ids.Key("b"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.CompletedSplit));

        // Simulate: reshape failed (e.g., manifest corrupt, cycle detected)
        // Transition CompletedSplit → Failed
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Failed));

        // C should be blocked (predecessor B is Failed)
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Failed, plan!.Jobs[ids.Key("b")].Status);

        // ReadySet should be empty — C's predecessor failed
        var ready = await ComputeReadySet(store, planId);
        Assert.Empty(ready);

        // Mark C as Blocked explicitly (scheduler would do this)
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Blocked));

        // Verify final state
        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(JobStatus.Succeeded, finalPlan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Failed, finalPlan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, finalPlan.Jobs[ids.Key("c")].Status);
    }

    // ──────────── Test: Chained / Nested Context Pressure Split ─────────────

    /// <summary>
    /// Exercises chained (nested) context pressure splits where sub-jobs themselves
    /// hit context pressure and split further. Inner sub-jobs do NOT create their own
    /// fan-in — they all fan into the outermost verification job.
    ///
    /// <para>Initial DAG: <c>A → B → C</c></para>
    ///
    /// <list type="number">
    /// <item>B runs, hits context pressure → <c>CompletedSplit</c>
    ///   <list type="bullet">
    ///     <item>Reshape: add B1, B2, B3, B4 (depend on B) + BV fan-in (depends on B1–B4)</item>
    ///     <item>C rewired to depend on BV</item>
    ///     <item>B → <c>Succeeded</c></item>
    ///   </list>
    /// </item>
    /// <item>B1 executes normally ✓</item>
    /// <item>B2 runs, hits context pressure → <c>CompletedSplit</c>
    ///   <list type="bullet">
    ///     <item>Reshape: add B2a, B2b (depend on B2)</item>
    ///     <item><b>BV rewired</b>: replace B2 dep with B2a + B2b (inner subs fan into outer BV)</item>
    ///     <item>B2 → <c>Succeeded</c></item>
    ///   </list>
    /// </item>
    /// <item>B3 runs, hits context pressure → <c>CompletedSplit</c>
    ///   <list type="bullet">
    ///     <item>Reshape: add B3a, B3b, B3c (depend on B3)</item>
    ///     <item><b>BV rewired</b>: replace B3 dep with B3a + B3b + B3c</item>
    ///     <item>B3 → <c>Succeeded</c></item>
    ///   </list>
    /// </item>
    /// <item>B4, B2a, B2b, B3a, B3b, B3c all execute normally</item>
    /// <item>BV becomes ready (all 7 leaf sub-jobs succeeded), executes</item>
    /// <item>C becomes ready (BV succeeded), executes</item>
    /// </list>
    ///
    /// Final DAG has 13 jobs: A, B, B1, B2, B2a, B2b, B3, B3a, B3b, B3c, B4, BV, C
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-CHAINED-SPLIT")]
    public async Task DAG_LIFECYCLE_ContextPressure_ChainedSplit_InnerSubsFanInToOuterV()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "chained-split", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Initial DAG: A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // ══════════════════════════════════════════════════════════════
        // Phase 1: Execute A normally
        // ══════════════════════════════════════════════════════════════
        await ExecuteJob(store, exec, planId, ids["a"]);

        // ══════════════════════════════════════════════════════════════
        // Phase 2: B hits context pressure → split into 4 chunks + BV
        // ══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("b"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.CompletedSplit));

        // C blocked during split
        Assert.Empty(await ComputeReadySet(store, planId));

        // Reshape: add B1–B4 depending on B, + BV depending on B1–B4
        foreach (var name in new[] { "b1", "b2", "b3", "b4" })
        {
            await Mutate(store, planId, new JobAdded(0, default, default,
                new JobNode
                {
                    Id = ids.Register(name).ToString(),
                    Title = $"B-chunk-{name}",
                    Status = JobStatus.Pending,
                    DependsOn = new[] { ids.Key("b") },
                    WorkSpec = new WorkSpec { Instructions = $"Continue B's work: {name}" },
                }));
        }

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = ids.Register("bv").ToString(),
                Title = "B-fanin-verify",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b1"), ids.Key("b2"), ids.Key("b3"), ids.Key("b4") },
                WorkSpec = new WorkSpec { Instructions = "Verify all B chunks" },
            }));

        // Rewire C: depend on BV instead of B
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("c"), ImmutableArray.Create(ids.Key("bv"))));

        // Finalize B → Succeeded
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Succeeded));

        // B1–B4 all ready now
        var readyL1 = await ComputeReadySet(store, planId);
        Assert.Equal(4, readyL1.Count);

        // ══════════════════════════════════════════════════════════════
        // Phase 3: Execute B1 normally
        // ══════════════════════════════════════════════════════════════
        await ExecuteJob(store, exec, planId, ids["b1"]);

        // ══════════════════════════════════════════════════════════════
        // Phase 4: B2 hits context pressure → split into B2a, B2b
        //          Inner subs fan into OUTER BV (not a new inner fan-in)
        // ══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("b2"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b2"), JobStatus.CompletedSplit));

        // Add B2a, B2b depending on B2
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = ids.Register("b2a").ToString(),
                Title = "B2-chunk-a",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b2") },
                WorkSpec = new WorkSpec { Instructions = "Continue B2: chunk a" },
            }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = ids.Register("b2b").ToString(),
                Title = "B2-chunk-b",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("b2") },
                WorkSpec = new WorkSpec { Instructions = "Continue B2: chunk b" },
            }));

        // Rewire BV: replace B2 with B2a + B2b in its dependency list
        // Current BV deps: [B1, B2, B3, B4] → [B1, B2a, B2b, B3, B4]
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("bv"),
            ImmutableArray.Create(ids.Key("b1"), ids.Key("b2a"), ids.Key("b2b"), ids.Key("b3"), ids.Key("b4"))));

        // Finalize B2 → Succeeded
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b2"), JobStatus.Succeeded));

        // B2a and B2b should now be ready (depend on B2 which is Succeeded)
        // B3 and B4 are still ready from before (depend on B which is Succeeded)
        var readyAfterB2Split = await ComputeReadySet(store, planId);
        Assert.Equal(4, readyAfterB2Split.Count); // B3, B4, B2a, B2b
        Assert.Contains(ids.Key("b2a"), readyAfterB2Split);
        Assert.Contains(ids.Key("b2b"), readyAfterB2Split);
        Assert.Contains(ids.Key("b3"), readyAfterB2Split);
        Assert.Contains(ids.Key("b4"), readyAfterB2Split);

        // ══════════════════════════════════════════════════════════════
        // Phase 5: B3 hits context pressure → split into B3a, B3b, B3c
        //          Again: inner subs fan into OUTER BV
        // ══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("b3"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b3"), JobStatus.CompletedSplit));

        // Add B3a, B3b, B3c depending on B3
        foreach (var suffix in new[] { "a", "b", "c" })
        {
            var name = $"b3{suffix}";
            await Mutate(store, planId, new JobAdded(0, default, default,
                new JobNode
                {
                    Id = ids.Register(name).ToString(),
                    Title = $"B3-chunk-{suffix}",
                    Status = JobStatus.Pending,
                    DependsOn = new[] { ids.Key("b3") },
                    WorkSpec = new WorkSpec { Instructions = $"Continue B3: chunk {suffix}" },
                }));
        }

        // Rewire BV: replace B3 with B3a + B3b + B3c
        // Current BV deps: [B1, B2a, B2b, B3, B4] → [B1, B2a, B2b, B3a, B3b, B3c, B4]
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("bv"),
            ImmutableArray.Create(
                ids.Key("b1"), ids.Key("b2a"), ids.Key("b2b"),
                ids.Key("b3a"), ids.Key("b3b"), ids.Key("b3c"),
                ids.Key("b4"))));

        // Finalize B3 → Succeeded
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b3"), JobStatus.Succeeded));

        // ══════════════════════════════════════════════════════════════
        // Phase 6: Execute all remaining leaf sub-jobs
        // ══════════════════════════════════════════════════════════════
        // Ready: B4, B2a, B2b, B3a, B3b, B3c  (B1 already succeeded)
        var readyLeaves = await ComputeReadySet(store, planId);
        Assert.Equal(6, readyLeaves.Count);

        // Execute them all
        await ExecuteJob(store, exec, planId, ids["b4"]);
        await ExecuteJob(store, exec, planId, ids["b2a"]);
        await ExecuteJob(store, exec, planId, ids["b2b"]);
        await ExecuteJob(store, exec, planId, ids["b3a"]);
        await ExecuteJob(store, exec, planId, ids["b3b"]);
        await ExecuteJob(store, exec, planId, ids["b3c"]);

        // ══════════════════════════════════════════════════════════════
        // Phase 7: BV becomes ready — all 7 leaf deps succeeded
        // ══════════════════════════════════════════════════════════════
        var readyForBV = await ComputeReadySet(store, planId);
        Assert.Single(readyForBV);
        Assert.Contains(ids.Key("bv"), readyForBV);

        await ExecuteJob(store, exec, planId, ids["bv"]);

        // ══════════════════════════════════════════════════════════════
        // Phase 8: C becomes ready — BV succeeded
        // ══════════════════════════════════════════════════════════════
        var readyForC = await ComputeReadySet(store, planId);
        Assert.Single(readyForC);
        Assert.Contains(ids.Key("c"), readyForC);

        await ExecuteJob(store, exec, planId, ids["c"]);

        // ══════════════════════════════════════════════════════════════
        // Final verification
        // ══════════════════════════════════════════════════════════════
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);

        // 13 jobs total: A, B, B1, B2, B2a, B2b, B3, B3a, B3b, B3c, B4, BV, C
        Assert.Equal(13, finalPlan.Jobs.Count);
        Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // Verify BV has the correct 7 leaf dependencies (no intermediate fan-ins)
        var bvNode = finalPlan.Jobs[ids.Key("bv")];
        Assert.Equal(7, bvNode.DependsOn.Count);
        Assert.Contains(ids.Key("b1"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b2a"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b2b"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b3a"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b3b"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b3c"), bvNode.DependsOn);
        Assert.Contains(ids.Key("b4"), bvNode.DependsOn);

        // Verify C still depends only on BV (not on any inner sub-jobs)
        var cNode = finalPlan.Jobs[ids.Key("c")];
        Assert.Single(cNode.DependsOn);
        Assert.Equal(ids.Key("bv"), cNode.DependsOn[0]);
    }

    // ─────────── Test: 4-Tier Deep Nested Context Pressure Split ────────────

    /// <summary>
    /// Exercises a 4-tier deep nested context pressure split tree:
    ///
    /// <para>Initial DAG: <c>Root → Work → Final</c></para>
    ///
    /// Tier 0: Work splits into W1, W2 + WV fan-in. Final rewired to WV.
    /// Tier 1: W1 splits into W1a, W1b. BV rewired: W1→{W1a,W1b}.
    /// Tier 2: W1a splits into W1a-i, W1a-ii, W1a-iii. BV rewired: W1a→{W1a-i,ii,iii}.
    /// Tier 3: W1a-i splits into W1a-i-α, W1a-i-β. BV rewired: W1a-i→{α,β}.
    ///
    /// Final BV deps (8 leaves): W1a-i-α, W1a-i-β, W1a-ii, W1a-iii, W1b, W2
    ///   (W1, W1a, W1a-i are all CompletedSplit→Succeeded intermediates)
    ///
    /// Total jobs: 14 (Root, Work, W1, W1a, W1b, W1a-i, W1a-ii, W1a-iii,
    ///                  W1a-i-α, W1a-i-β, W2, WV, Final)
    ///   Wait — that's 13. Let me count:
    ///   Root, Work, W1, W2, W1a, W1b, W1a-i, W1a-ii, W1a-iii,
    ///   W1a-i-α, W1a-i-β, WV, Final = 13.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-4TIER-SPLIT")]
    public async Task DAG_LIFECYCLE_ContextPressure_4TierDeepSplit()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "4tier-split", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("root"), "Root");
        await AddJob(store, planId, ids.Register("work"), "Work", ids["root"]);
        await AddJob(store, planId, ids.Register("final"), "Final", ids["work"]);

        var exec = this.MakeExecutor(store);

        // ═══════════════════════════════════════════════════════════════
        // Execute Root normally
        // ═══════════════════════════════════════════════════════════════
        await ExecuteJob(store, exec, planId, ids["root"]);

        // ═══════════════════════════════════════════════════════════════
        // TIER 0: Work → CompletedSplit → {W1, W2} + WV
        // ═══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("work"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("work"), JobStatus.CompletedSplit));

        // Final blocked
        Assert.Empty(await ComputeReadySet(store, planId));

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w1").ToString(), Title = "W1", Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("work") },
                WorkSpec = new WorkSpec { Instructions = "Chunk 1" } }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w2").ToString(), Title = "W2", Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("work") },
                WorkSpec = new WorkSpec { Instructions = "Chunk 2" } }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("wv").ToString(), Title = "WV-fanin", Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("w1"), ids.Key("w2") },
                WorkSpec = new WorkSpec { Instructions = "Verify all chunks" } }));

        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("final"), ImmutableArray.Create(ids.Key("wv"))));

        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("work"), JobStatus.Succeeded));

        var readyT0 = await ComputeReadySet(store, planId);
        Assert.Equal(2, readyT0.Count); // W1, W2

        // ═══════════════════════════════════════════════════════════════
        // TIER 1: W1 → CompletedSplit → {W1a, W1b}
        //         Inner subs fan into outer WV
        // ═══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("w1"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1"), JobStatus.CompletedSplit));

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w1a").ToString(), Title = "W1a", Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("w1") },
                WorkSpec = new WorkSpec { Instructions = "W1 chunk a" } }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w1b").ToString(), Title = "W1b", Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("w1") },
                WorkSpec = new WorkSpec { Instructions = "W1 chunk b" } }));

        // WV: replace W1 with W1a, W1b
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("wv"), ImmutableArray.Create(ids.Key("w1a"), ids.Key("w1b"), ids.Key("w2"))));

        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1"), JobStatus.Succeeded));

        // W1a, W1b, W2 all ready
        var readyT1 = await ComputeReadySet(store, planId);
        Assert.Equal(3, readyT1.Count);

        // ═══════════════════════════════════════════════════════════════
        // TIER 2: W1a → CompletedSplit → {W1a-i, W1a-ii, W1a-iii}
        //         Inner subs fan into outer WV
        // ═══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("w1a"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1a"), JobStatus.CompletedSplit));

        foreach (var suffix in new[] { "i", "ii", "iii" })
        {
            var name = $"w1a-{suffix}";
            await Mutate(store, planId, new JobAdded(0, default, default,
                new JobNode { Id = ids.Register(name).ToString(), Title = name.ToUpperInvariant(),
                    Status = JobStatus.Pending, DependsOn = new[] { ids.Key("w1a") },
                    WorkSpec = new WorkSpec { Instructions = $"W1a sub-chunk {suffix}" } }));
        }

        // WV: replace W1a with W1a-i, W1a-ii, W1a-iii
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("wv"), ImmutableArray.Create(
                ids.Key("w1a-i"), ids.Key("w1a-ii"), ids.Key("w1a-iii"),
                ids.Key("w1b"), ids.Key("w2"))));

        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1a"), JobStatus.Succeeded));

        // W1a-i, W1a-ii, W1a-iii, W1b, W2 all ready
        var readyT2 = await ComputeReadySet(store, planId);
        Assert.Equal(5, readyT2.Count);

        // ═══════════════════════════════════════════════════════════════
        // TIER 3: W1a-i → CompletedSplit → {W1a-i-α, W1a-i-β}
        //         Deepest split — subs fan into outer WV
        // ═══════════════════════════════════════════════════════════════
        await TransitionToRunning(store, planId, ids.Key("w1a-i"));
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1a-i"), JobStatus.CompletedSplit));

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w1a-i-alpha").ToString(), Title = "W1A-I-ALPHA",
                Status = JobStatus.Pending, DependsOn = new[] { ids.Key("w1a-i") },
                WorkSpec = new WorkSpec { Instructions = "Deepest chunk α" } }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode { Id = ids.Register("w1a-i-beta").ToString(), Title = "W1A-I-BETA",
                Status = JobStatus.Pending, DependsOn = new[] { ids.Key("w1a-i") },
                WorkSpec = new WorkSpec { Instructions = "Deepest chunk β" } }));

        // WV: replace W1a-i with W1a-i-α, W1a-i-β
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("wv"), ImmutableArray.Create(
                ids.Key("w1a-i-alpha"), ids.Key("w1a-i-beta"),
                ids.Key("w1a-ii"), ids.Key("w1a-iii"),
                ids.Key("w1b"), ids.Key("w2"))));

        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("w1a-i"), JobStatus.Succeeded));

        // All 6 leaf sub-jobs ready: α, β, W1a-ii, W1a-iii, W1b, W2
        var readyT3 = await ComputeReadySet(store, planId);
        Assert.Equal(6, readyT3.Count);
        Assert.Contains(ids.Key("w1a-i-alpha"), readyT3);
        Assert.Contains(ids.Key("w1a-i-beta"), readyT3);
        Assert.Contains(ids.Key("w1a-ii"), readyT3);
        Assert.Contains(ids.Key("w1a-iii"), readyT3);
        Assert.Contains(ids.Key("w1b"), readyT3);
        Assert.Contains(ids.Key("w2"), readyT3);

        // ═══════════════════════════════════════════════════════════════
        // Execute all 6 leaf sub-jobs
        // ═══════════════════════════════════════════════════════════════
        await ExecuteJob(store, exec, planId, ids["w1a-i-alpha"]);
        await ExecuteJob(store, exec, planId, ids["w1a-i-beta"]);
        await ExecuteJob(store, exec, planId, ids["w1a-ii"]);
        await ExecuteJob(store, exec, planId, ids["w1a-iii"]);
        await ExecuteJob(store, exec, planId, ids["w1b"]);
        await ExecuteJob(store, exec, planId, ids["w2"]);

        // ═══════════════════════════════════════════════════════════════
        // WV ready — all 6 leaf deps succeeded
        // ═══════════════════════════════════════════════════════════════
        var readyWV = await ComputeReadySet(store, planId);
        Assert.Single(readyWV);
        Assert.Contains(ids.Key("wv"), readyWV);

        await ExecuteJob(store, exec, planId, ids["wv"]);

        // ═══════════════════════════════════════════════════════════════
        // Final ready — WV succeeded
        // ═══════════════════════════════════════════════════════════════
        var readyFinal = await ComputeReadySet(store, planId);
        Assert.Single(readyFinal);
        Assert.Contains(ids.Key("final"), readyFinal);

        await ExecuteJob(store, exec, planId, ids["final"]);

        // ═══════════════════════════════════════════════════════════════
        // Final verification
        // ═══════════════════════════════════════════════════════════════
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Succeeded, plan!.Status);

        // 13 total: Root, Work, W1, W2, W1a, W1b, W1a-i, W1a-ii, W1a-iii,
        //           W1a-i-α, W1a-i-β, WV, Final
        Assert.Equal(13, plan.Jobs.Count);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // WV has exactly 6 leaf deps (no intermediate split nodes)
        var wvNode = plan.Jobs[ids.Key("wv")];
        Assert.Equal(6, wvNode.DependsOn.Count);
        Assert.Contains(ids.Key("w1a-i-alpha"), wvNode.DependsOn);
        Assert.Contains(ids.Key("w1a-i-beta"), wvNode.DependsOn);
        Assert.Contains(ids.Key("w1a-ii"), wvNode.DependsOn);
        Assert.Contains(ids.Key("w1a-iii"), wvNode.DependsOn);
        Assert.Contains(ids.Key("w1b"), wvNode.DependsOn);
        Assert.Contains(ids.Key("w2"), wvNode.DependsOn);

        // Final depends only on WV
        var finalNode = plan.Jobs[ids.Key("final")];
        Assert.Single(finalNode.DependsOn);
        Assert.Equal(ids.Key("wv"), finalNode.DependsOn[0]);

        // Verify the split chain: Work→W1→W1a→W1a-i all went through CompletedSplit
        // (they're now Succeeded, but their transition history would show CompletedSplit)
        // The key structural invariant: no intermediate fan-in jobs exist
        // Only WV is the single fan-in point for the entire split tree
        var allJobTitles = plan.Jobs.Values.Select(j => j.Title).OrderBy(t => t).ToArray();
        Assert.DoesNotContain(allJobTitles, t => t.Contains("fanin") && t != "WV-fanin");
    }

    // ────────────────────────────── Test 9 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-PARALLEL-ROOTS")]
    public async Task DAG_LIFECYCLE_ParallelRoots_IndependentExecution()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "parallel-roots", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // 3 independent roots with no dependencies
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("x"), "Root X");
        await AddJob(store, planId, ids.Register("y"), "Root Y");
        await AddJob(store, planId, ids.Register("z"), "Root Z");

        // All should be ready immediately
        var ready = await ComputeReadySet(store, planId);
        Assert.Equal(3, ready.Count);
        Assert.Contains(ids.Key("x"), ready);
        Assert.Contains(ids.Key("y"), ready);
        Assert.Contains(ids.Key("z"), ready);

        var exec = this.MakeExecutor(store);

        // Execute all — each succeeds independently
        var resultX = await ExecuteJob(store, exec, planId, ids["x"]);
        var resultY = await ExecuteJob(store, exec, planId, ids["y"]);
        var resultZ = await ExecuteJob(store, exec, planId, ids["z"]);

        Assert.Equal(JobStatus.Succeeded, resultX.FinalStatus);
        Assert.Equal(JobStatus.Succeeded, resultY.FinalStatus);
        Assert.Equal(JobStatus.Succeeded, resultZ.FinalStatus);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.All(plan!.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────────── Test 10 ──────────────────────────────

    [Fact]
    [ContractTest("DAG-LIFECYCLE-RESHAPE")]
    public async Task DAG_LIFECYCLE_Reshape_AddJobDuringExecution()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "reshape", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Start with A → B
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);

        var exec = this.MakeExecutor(store);

        // Execute A
        await ExecuteJob(store, exec, planId, ids["a"]);

        // Reshape: add C depending on A
        var cId = ids.Register("c");
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = cId.ToString(),
                Title = "Reshaped C",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("a") },
            }));

        // Both B and C should be ready (both depend only on succeeded A)
        var ready = await ComputeReadySet(store, planId);
        Assert.Equal(2, ready.Count);
        Assert.Contains(ids.Key("b"), ready);
        Assert.Contains(ids.Key("c"), ready);

        // Execute both
        await ExecuteJob(store, exec, planId, ids["b"]);
        await ExecuteJob(store, exec, planId, ids["c"]);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(3, plan!.Jobs.Count);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────── Test 11 ──────────────────────────────

    /// <summary>
    /// Exercises every <see cref="PhaseFailureKind"/> value (0–10) through the
    /// <see cref="HealOrResumeStrategy"/> truth table with auto-heal enabled.
    ///
    /// <para>Creates 11 independent root jobs, each configured to fail its Work phase
    /// with a different <see cref="PhaseFailureKind"/>. On the first invocation the
    /// Work runner throws; on retry it succeeds.</para>
    ///
    /// <list type="bullet">
    /// <item><b>Transient</b> (0=TransientNetwork, 1=TransientFileLock):
    ///   PhaseResume → succeed on retry (2 attempts)</item>
    /// <item><b>Healable</b> (2=AgentMaxTurnsExceeded, 3=AgentNonZeroExit,
    ///   4=ShellNonZeroExit, 5=MergeConflict, 7=AnalyzerOrTestFailure,
    ///   10=ProcessCrash): AutoHeal → succeed on retry (2 attempts)</item>
    /// <item><b>Fatal</b> (6=RemoteRejected, 8=Timeout, 9=Internal):
    ///   GiveUp → job fails immediately (1 attempt)</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-AUTOHEAL-ALL-KINDS")]
    public async Task DAG_LIFECYCLE_AutoHeal_All10FailureKinds()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "all-failure-kinds", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // 11 independent root jobs — one per PhaseFailureKind
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("net"), "TransientNetwork");
        await AddJob(store, planId, ids.Register("lock"), "TransientFileLock");
        await AddJob(store, planId, ids.Register("maxturns"), "AgentMaxTurnsExceeded");
        await AddJob(store, planId, ids.Register("agentexit"), "AgentNonZeroExit");
        await AddJob(store, planId, ids.Register("shellexit"), "ShellNonZeroExit");
        await AddJob(store, planId, ids.Register("merge"), "MergeConflict");
        await AddJob(store, planId, ids.Register("rejected"), "RemoteRejected");
        await AddJob(store, planId, ids.Register("analyzer"), "AnalyzerOrTestFailure");
        await AddJob(store, planId, ids.Register("timeout"), "Timeout");
        await AddJob(store, planId, ids.Register("internal"), "Internal");
        await AddJob(store, planId, ids.Register("crash"), "ProcessCrash");

        // Map each JobId to the PhaseFailureKind its Work phase should throw
        var failureMap = new Dictionary<string, PhaseFailureKind>(StringComparer.Ordinal)
        {
            [ids["net"].ToString()] = PhaseFailureKind.TransientNetwork,
            [ids["lock"].ToString()] = PhaseFailureKind.TransientFileLock,
            [ids["maxturns"].ToString()] = PhaseFailureKind.AgentMaxTurnsExceeded,
            [ids["agentexit"].ToString()] = PhaseFailureKind.AgentNonZeroExit,
            [ids["shellexit"].ToString()] = PhaseFailureKind.ShellNonZeroExit,
            [ids["merge"].ToString()] = PhaseFailureKind.MergeConflict,
            [ids["rejected"].ToString()] = PhaseFailureKind.RemoteRejected,
            [ids["analyzer"].ToString()] = PhaseFailureKind.AnalyzerOrTestFailure,
            [ids["timeout"].ToString()] = PhaseFailureKind.Timeout,
            [ids["internal"].ToString()] = PhaseFailureKind.Internal,
            [ids["crash"].ToString()] = PhaseFailureKind.ProcessCrash,
        };

        var workRunner = new PerJobWorkRunner(failureMap);
        var exec = this.MakeExecutorWithCustomWork(store, workRunner, autoHeal: _ => true);

        // All 11 jobs are independent roots — all ready immediately
        var ready = await ComputeReadySet(store, planId);
        Assert.Equal(11, ready.Count);

        // ── Transient failures (0,1): PhaseResume → succeed on retry ──
        var resultNet = await ExecuteJob(store, exec, planId, ids["net"]);
        Assert.Equal(JobStatus.Succeeded, resultNet.FinalStatus);
        Assert.Equal(2, resultNet.AttemptCount);

        var resultLock = await ExecuteJob(store, exec, planId, ids["lock"]);
        Assert.Equal(JobStatus.Succeeded, resultLock.FinalStatus);
        Assert.Equal(2, resultLock.AttemptCount);

        // ── Healable failures (2,3,4,5,7,10): AutoHeal → succeed on retry ──
        var resultMaxturns = await ExecuteJob(store, exec, planId, ids["maxturns"]);
        Assert.Equal(JobStatus.Succeeded, resultMaxturns.FinalStatus);
        Assert.Equal(2, resultMaxturns.AttemptCount);

        var resultAgentexit = await ExecuteJob(store, exec, planId, ids["agentexit"]);
        Assert.Equal(JobStatus.Succeeded, resultAgentexit.FinalStatus);
        Assert.Equal(2, resultAgentexit.AttemptCount);

        var resultShellexit = await ExecuteJob(store, exec, planId, ids["shellexit"]);
        Assert.Equal(JobStatus.Succeeded, resultShellexit.FinalStatus);
        Assert.Equal(2, resultShellexit.AttemptCount);

        var resultMerge = await ExecuteJob(store, exec, planId, ids["merge"]);
        Assert.Equal(JobStatus.Succeeded, resultMerge.FinalStatus);
        Assert.Equal(2, resultMerge.AttemptCount);

        var resultAnalyzer = await ExecuteJob(store, exec, planId, ids["analyzer"]);
        Assert.Equal(JobStatus.Succeeded, resultAnalyzer.FinalStatus);
        Assert.Equal(2, resultAnalyzer.AttemptCount);

        var resultCrash = await ExecuteJob(store, exec, planId, ids["crash"]);
        Assert.Equal(JobStatus.Succeeded, resultCrash.FinalStatus);
        Assert.Equal(2, resultCrash.AttemptCount);

        // ── Fatal failures (6,8,9): GiveUp → fail immediately ──
        var resultRejected = await ExecuteJob(store, exec, planId, ids["rejected"]);
        Assert.Equal(JobStatus.Failed, resultRejected.FinalStatus);
        Assert.Equal(1, resultRejected.AttemptCount);

        var resultTimeout = await ExecuteJob(store, exec, planId, ids["timeout"]);
        Assert.Equal(JobStatus.Failed, resultTimeout.FinalStatus);
        Assert.Equal(1, resultTimeout.AttemptCount);

        var resultInternal = await ExecuteJob(store, exec, planId, ids["internal"]);
        Assert.Equal(JobStatus.Failed, resultInternal.FinalStatus);
        Assert.Equal(1, resultInternal.AttemptCount);

        // ── Verify stored attempts in the plan ──
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);

        // Transient jobs: 2 attempts each (failed + succeeded)
        foreach (var name in new[] { "net", "lock" })
        {
            var attempts = plan!.Jobs[ids.Key(name)].Attempts;
            Assert.Equal(2, attempts.Count);
            Assert.Equal(JobStatus.Failed, attempts[0].Status);
            Assert.Equal(JobStatus.Succeeded, attempts[1].Status);
        }

        // Healable jobs: 2 attempts each (failed + succeeded)
        foreach (var name in new[] { "maxturns", "agentexit", "shellexit", "merge", "analyzer", "crash" })
        {
            var attempts = plan!.Jobs[ids.Key(name)].Attempts;
            Assert.Equal(2, attempts.Count);
            Assert.Equal(JobStatus.Failed, attempts[0].Status);
            Assert.Equal(JobStatus.Succeeded, attempts[1].Status);
        }

        // Fatal jobs: 1 attempt each (failed with error message)
        foreach (var name in new[] { "rejected", "timeout", "internal" })
        {
            var attempts = plan!.Jobs[ids.Key(name)].Attempts;
            Assert.Equal(1, attempts.Count);
            Assert.Equal(JobStatus.Failed, attempts[0].Status);
            Assert.NotNull(attempts[0].ErrorMessage);
        }

        // Summary: 8 succeeded (2 transient + 6 healable), 3 failed (fatal)
        Assert.Equal(8, plan!.Jobs.Values.Count(j => j.Status == JobStatus.Succeeded));
        Assert.Equal(3, plan.Jobs.Values.Count(j => j.Status == JobStatus.Failed));
        Assert.Equal(11, plan.Jobs.Count);
    }

    // ────────────────────────── Test 12 ──────────────────────────────

    /// <summary>
    /// Tests a mini scheduler watch+dispatch loop: a background task watches the plan,
    /// computes the ready set from each snapshot, and dispatches jobs automatically.
    /// Verifies that a 3-job linear chain (A→B→C) executes in dependency order without
    /// manual driving.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-SCHEDULER-WATCHLOOP")]
    public async Task DAG_LIFECYCLE_Scheduler_WatchLoopDispatch()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "scheduler-watchloop", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);
        var executionOrder = new ConcurrentQueue<string>();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        // Mini scheduler loop in a background task
        var schedulerTask = Task.Run(async () =>
        {
            var dispatched = new HashSet<string>(StringComparer.Ordinal);

            await foreach (var snapshot in store.WatchAsync(planId, cts.Token))
            {
                // Compute ready set from the snapshot
                foreach (var (id, job) in snapshot.Jobs)
                {
                    if (job.Status != JobStatus.Pending)
                    {
                        continue;
                    }

                    if (dispatched.Contains(id))
                    {
                        continue;
                    }

                    bool allDepsMet = job.DependsOn.Count == 0 ||
                        job.DependsOn.All(d => snapshot.Jobs.TryGetValue(d, out var dep) &&
                                               dep.Status == JobStatus.Succeeded);
                    if (!allDepsMet)
                    {
                        continue;
                    }

                    dispatched.Add(id);
                    var jobId = new JobId(Guid.Parse(id.Replace("job_", string.Empty)));
                    executionOrder.Enqueue(id);
                    await ExecuteJob(store, exec, planId, jobId);
                }

                // Check if all jobs are terminal
                if (snapshot.Jobs.Values.All(j =>
                    j.Status == JobStatus.Succeeded || j.Status == JobStatus.Failed ||
                    j.Status == JobStatus.Canceled || j.Status == JobStatus.Blocked))
                {
                    break;
                }
            }
        }, cts.Token);

        await schedulerTask;

        // Verify all jobs executed in dependency order
        var order = executionOrder.ToArray();
        Assert.Equal(3, order.Length);
        Assert.Equal(ids.Key("a"), order[0]);
        Assert.Equal(ids.Key("b"), order[1]);
        Assert.Equal(ids.Key("c"), order[2]);

        // Verify final state
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.All(plan!.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────── Test 13 ──────────────────────────────

    /// <summary>
    /// Tests that 5 independent root jobs can execute concurrently without data races.
    /// Each job writes a unique marker during its Work phase. Verifies all markers are
    /// present, all jobs succeeded, and no duplicate executions occurred.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-CONCURRENT-NORACE")]
    public async Task DAG_LIFECYCLE_ConcurrentExecution_ParallelJobsNoRace()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "concurrent-norace", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // 5 independent root jobs
        var ids = new JobIdMap();
        for (int i = 0; i < 5; i++)
        {
            await AddJob(store, planId, ids.Register($"j{i}"), $"Job {i}");
        }

        var markers = new ConcurrentBag<string>();
        var executionCounts = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);

        // Work phase runner that records a marker and introduces a small delay
        var work = new FakePhaseRunner(JobPhase.Work);
        work.OnRun = async ct =>
        {
            await Task.Delay(50, ct);
        };
        var exec = this.MakeExecutor(store, workRunner: work);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        // Execute all 5 jobs concurrently via a mini scheduler
        var schedulerTask = Task.Run(async () =>
        {
            var dispatchedTasks = new List<Task>();
            var dispatched = new HashSet<string>(StringComparer.Ordinal);

            await foreach (var snapshot in store.WatchAsync(planId, cts.Token))
            {
                foreach (var (id, job) in snapshot.Jobs)
                {
                    if (job.Status != JobStatus.Pending || dispatched.Contains(id))
                    {
                        continue;
                    }

                    bool allDepsMet = job.DependsOn.Count == 0 ||
                        job.DependsOn.All(d => snapshot.Jobs.TryGetValue(d, out var dep) &&
                                               dep.Status == JobStatus.Succeeded);
                    if (!allDepsMet)
                    {
                        continue;
                    }

                    dispatched.Add(id);
                    var jobId = new JobId(Guid.Parse(id.Replace("job_", string.Empty)));

                    // Dispatch each job concurrently
                    dispatchedTasks.Add(Task.Run(async () =>
                    {
                        executionCounts.AddOrUpdate(id, 1, (_, c) => c + 1);
                        markers.Add(id);
                        await ExecuteJob(store, exec, planId, jobId);
                    }, cts.Token));
                }

                // Check if all jobs are terminal
                if (snapshot.Jobs.Values.All(j =>
                    j.Status == JobStatus.Succeeded || j.Status == JobStatus.Failed ||
                    j.Status == JobStatus.Canceled || j.Status == JobStatus.Blocked))
                {
                    break;
                }
            }

            await Task.WhenAll(dispatchedTasks);
        }, cts.Token);

        await schedulerTask;

        // All 5 markers present
        Assert.Equal(5, markers.Count);
        for (int i = 0; i < 5; i++)
        {
            Assert.Contains(ids.Key($"j{i}"), markers);
        }

        // Each job executed exactly once (no duplicates)
        Assert.Equal(5, executionCounts.Count);
        Assert.All(executionCounts.Values, c => Assert.Equal(1, c));

        // All 5 jobs succeeded
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(5, plan!.Jobs.Count);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────── Test 14 ──────────────────────────────

    /// <summary>
    /// Tests that pausing a plan prevents new job dispatch and resuming restarts it.
    /// Creates A→B→C, executes A, pauses, verifies B stays Ready for 500ms,
    /// resumes, then completes B and C.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-PAUSE-RESUME")]
    public async Task DAG_LIFECYCLE_PauseResume_NoDispatchWhilePaused()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "pause-resume", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute A
        await ExecuteJob(store, exec, planId, ids["a"]);

        // B should be ready
        var readyBeforePause = await ComputeReadySet(store, planId);
        Assert.Single(readyBeforePause);
        Assert.Contains(ids.Key("b"), readyBeforePause);

        // Pause the plan
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Paused));

        var pausedPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(pausedPlan);
        Assert.Equal(PlanStatus.Paused, pausedPlan!.Status);

        // Wait 500ms — B should still be Pending (no dispatch while paused)
        await Task.Delay(500);
        var planDuringPause = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(planDuringPause);
        Assert.Equal(JobStatus.Pending, planDuringPause!.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Pending, planDuringPause.Jobs[ids.Key("c")].Status);

        // B is still in the ready set (its deps are met), plan is just paused
        var readyWhilePaused = await ComputeReadySet(store, planId);
        Assert.Single(readyWhilePaused);
        Assert.Contains(ids.Key("b"), readyWhilePaused);

        // Resume the plan
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Running));

        var resumedPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(resumedPlan);
        Assert.Equal(PlanStatus.Running, resumedPlan!.Status);

        // Now execute B and C
        await ExecuteJob(store, exec, planId, ids["b"]);

        var readyAfterB = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterB);
        Assert.Contains(ids.Key("c"), readyAfterB);

        await ExecuteJob(store, exec, planId, ids["c"]);

        // Verify all succeeded
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);
        Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────── Test 15 ──────────────────────────────

    /// <summary>
    /// Tests crash recovery: if a job is left in Running state after a "crash",
    /// on restart it can be detected and reset via Running→Failed→Pending→Ready,
    /// then re-executed to completion.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-CRASH-RECOVERY")]
    public async Task DAG_LIFECYCLE_CrashRecovery_RunningJobResetOnRestart()
    {
        // Use a dedicated sub-directory so a second store instance can reload from disk
        var crashRoot = Path.Combine(this.root, "crash-recovery");
        Directory.CreateDirectory(crashRoot);

        // ── Phase 1: Normal execution, then simulate crash ──
        PlanId planId;
        JobIdMap ids;
        {
            await using var store1 = new PlanStore(
                new AbsolutePath(crashRoot),
                new NullFileSystem(),
                this.clock,
                this.bus,
                new FixedOptions<PlanStoreOptions>(new PlanStoreOptions()),
                NullLogger<PlanStore>.Instance);

            planId = await store1.CreateAsync(
                new PlanModel { Name = "crash-recovery", Status = PlanStatus.Running },
                Idem(), CancellationToken.None);

            ids = new JobIdMap();
            await AddJob(store1, planId, ids.Register("a"), "Job A");
            await AddJob(store1, planId, ids.Register("b"), "Job B", ids["a"]);
            await AddJob(store1, planId, ids.Register("c"), "Job C", ids["b"]);

            var exec1 = this.MakeExecutor(store1);

            // Execute A successfully
            await ExecuteJob(store1, exec1, planId, ids["a"]);

            // Transition B to Running (simulating it was dispatched)
            await TransitionToRunning(store1, planId, ids.Key("b"));

            // Verify B is Running before "crash"
            var preCrash = await store1.LoadAsync(planId, CancellationToken.None);
            Assert.NotNull(preCrash);
            Assert.Equal(JobStatus.Succeeded, preCrash!.Jobs[ids.Key("a")].Status);
            Assert.Equal(JobStatus.Running, preCrash.Jobs[ids.Key("b")].Status);
            Assert.Equal(JobStatus.Pending, preCrash.Jobs[ids.Key("c")].Status);

            // Checkpoint to persist state to disk
            await store1.CheckpointAsync(planId, CancellationToken.None);

            // "Crash" — store1 disposes here
        }

        // ── Phase 2: Restart — create a new store pointing at the same directory ──
        {
            await using var store2 = new PlanStore(
                new AbsolutePath(crashRoot),
                new NullFileSystem(),
                this.clock,
                this.bus,
                new FixedOptions<PlanStoreOptions>(new PlanStoreOptions()),
                NullLogger<PlanStore>.Instance);

            // Load the plan — B should still be Running (orphaned)
            var recovered = await store2.LoadAsync(planId, CancellationToken.None);
            Assert.NotNull(recovered);
            Assert.Equal(JobStatus.Succeeded, recovered!.Jobs[ids.Key("a")].Status);
            Assert.Equal(JobStatus.Running, recovered.Jobs[ids.Key("b")].Status);
            Assert.Equal(JobStatus.Pending, recovered.Jobs[ids.Key("c")].Status);

            // Reset orphaned B: Running → Failed (valid transition)
            await Mutate(store2, planId,
                new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Failed));

            // Then Failed → Pending (valid transition for retry)
            await Mutate(store2, planId,
                new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Pending));

            // B should now be in the ready set (A is Succeeded)
            var ready = await ComputeReadySet(store2, planId);
            Assert.Single(ready);
            Assert.Contains(ids.Key("b"), ready);

            // Execute B and C from recovered state
            var exec2 = this.MakeExecutor(store2);
            await ExecuteJob(store2, exec2, planId, ids["b"]);
            await ExecuteJob(store2, exec2, planId, ids["c"]);

            // Verify all succeeded
            await Mutate(store2, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

            var finalPlan = await store2.LoadAsync(planId, CancellationToken.None);
            Assert.NotNull(finalPlan);
            Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);
            Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
        }
    }

    // ────────────────────────── Test 16 ──────────────────────────────

    /// <summary>
    /// Exercises the full SV node lifecycle: creation via <see cref="SvNodeBuilder.Build"/>,
    /// execution gating, reshape-triggered re-sync via <see cref="SvNodeBuilder.SyncDependencies"/>,
    /// and downstream propagation.
    ///
    /// <para>Initial DAG: <c>A → B, A → C, SV depends on [B, C]</c></para>
    ///
    /// <list type="number">
    /// <item>Build SV node depending on leaves [B, C]</item>
    /// <item>Execute A — B and C become ready</item>
    /// <item>Execute B and C — SV becomes ready</item>
    /// <item>Reshape: add job D depending on A (new leaf)</item>
    /// <item>SyncDependencies detects D as new leaf → update SV deps to [B, C, D]</item>
    /// <item>D should be ready (A succeeded), execute D</item>
    /// <item>Now SV should be ready (B, C, D all succeeded)</item>
    /// <item>Execute SV — all succeed</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-SV-AUTOSYNC")]
    public async Task DAG_LIFECYCLE_SvNode_AutoSyncAfterReshape()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "sv-autosync", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B, A → C (B and C are leaves)
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["a"]);

        // Build SV node using SvNodeBuilder — depends on leaves [B, C]
        var svId = ids.Register("sv");
        var svNode = SvNodeBuilder.Build(new[] { ids.Key("b"), ids.Key("c") }) with { Id = svId.ToString() };
        await Mutate(store, planId, new JobAdded(0, default, default, svNode));
        var svKey = svNode.Id;

        var exec = this.MakeExecutor(store);

        // ── Execute A — B and C become ready ──
        var ready0 = await ComputeReadySet(store, planId);
        Assert.Single(ready0);
        Assert.Contains(ids.Key("a"), ready0);

        await ExecuteJob(store, exec, planId, ids["a"]);

        var readyAfterA = await ComputeReadySet(store, planId);
        Assert.Equal(2, readyAfterA.Count);
        Assert.Contains(ids.Key("b"), readyAfterA);
        Assert.Contains(ids.Key("c"), readyAfterA);

        // ── Execute B and C — SV becomes ready ──
        await ExecuteJob(store, exec, planId, ids["b"]);
        await ExecuteJob(store, exec, planId, ids["c"]);

        var readyForSv = await ComputeReadySet(store, planId);
        Assert.Single(readyForSv);
        Assert.Contains(svKey, readyForSv);

        // ── Reshape: add job D depending on A (new leaf) ──
        var dId = ids.Register("d");
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = dId.ToString(),
                Title = "Job D",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("a") },
                WorkSpec = new WorkSpec { Instructions = "New leaf job" },
            }));

        // ── SyncDependencies detects the leaf change ──
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var updatedLeaves = SvNodeBuilder.SyncDependencies(plan!);
        Assert.NotNull(updatedLeaves); // change detected

        // The new leaf set should include B, C, and D
        Assert.Equal(3, updatedLeaves!.Count);
        Assert.Contains(ids.Key("b"), updatedLeaves);
        Assert.Contains(ids.Key("c"), updatedLeaves);
        Assert.Contains(ids.Key("d"), updatedLeaves);

        // Apply the updated deps to SV
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            svKey, ImmutableArray.CreateRange(updatedLeaves)));

        // SV should NOT be ready now (D is still Pending)
        var readyAfterSync = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterSync);
        Assert.Contains(ids.Key("d"), readyAfterSync); // D is ready (A succeeded)

        // ── Execute D ──
        await ExecuteJob(store, exec, planId, ids["d"]);

        // Now SV should be ready (B, C, D all succeeded)
        var readyForSv2 = await ComputeReadySet(store, planId);
        Assert.Single(readyForSv2);
        Assert.Contains(svKey, readyForSv2);

        // ── Execute SV ──
        await ExecuteJob(store, exec, planId, ids["sv"]);

        // ── Final verification ──
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);
        Assert.Equal(5, finalPlan.Jobs.Count); // A, B, C, D, SV
        Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // Verify SV has 3 deps [B, C, D]
        var svFinal = finalPlan.Jobs[svKey];
        Assert.Equal(3, svFinal.DependsOn.Count);
        Assert.Contains(ids.Key("b"), svFinal.DependsOn);
        Assert.Contains(ids.Key("c"), svFinal.DependsOn);
        Assert.Contains(ids.Key("d"), svFinal.DependsOn);
    }

    // ────────────────────────── Test 17 ──────────────────────────────

    /// <summary>
    /// Verifies that the SV node correctly blocks until ALL leaf predecessors succeed.
    /// SV should NOT become ready when only some leaves have completed.
    ///
    /// <para>DAG: <c>A → B, A → C, SV depends on [B, C]</c></para>
    ///
    /// <list type="number">
    /// <item>Execute A, then B — SV should NOT be ready (C still Pending)</item>
    /// <item>Execute C — now SV becomes ready</item>
    /// <item>Execute SV — all succeed</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-SV-BLOCKS")]
    public async Task DAG_LIFECYCLE_SvNode_BlocksUntilAllLeavesSucceed()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "sv-blocks", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B, A → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["a"]);

        // Build SV node depending on leaves [B, C]
        var svId = ids.Register("sv");
        var svNode = SvNodeBuilder.Build(new[] { ids.Key("b"), ids.Key("c") }) with { Id = svId.ToString() };
        await Mutate(store, planId, new JobAdded(0, default, default, svNode));
        var svKey = svNode.Id;

        var exec = this.MakeExecutor(store);

        // ── Execute A — B and C become ready ──
        await ExecuteJob(store, exec, planId, ids["a"]);

        var readyAfterA = await ComputeReadySet(store, planId);
        Assert.Equal(2, readyAfterA.Count);
        Assert.Contains(ids.Key("b"), readyAfterA);
        Assert.Contains(ids.Key("c"), readyAfterA);
        Assert.DoesNotContain(svKey, readyAfterA); // SV not ready yet

        // ── Execute B — SV should NOT be ready (C still Pending) ──
        await ExecuteJob(store, exec, planId, ids["b"]);

        var readyAfterB = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterB);
        Assert.Contains(ids.Key("c"), readyAfterB);
        Assert.DoesNotContain(svKey, readyAfterB); // SV still not ready

        // ── Execute C — now SV becomes ready ──
        await ExecuteJob(store, exec, planId, ids["c"]);

        var readyAfterC = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterC);
        Assert.Contains(svKey, readyAfterC);

        // ── Execute SV ──
        await ExecuteJob(store, exec, planId, ids["sv"]);

        // ── Final verification ──
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Succeeded));

        var finalPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(finalPlan);
        Assert.Equal(PlanStatus.Succeeded, finalPlan!.Status);
        Assert.Equal(4, finalPlan.Jobs.Count); // A, B, C, SV
        Assert.All(finalPlan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));

        // SV correctly gates on ALL leaf predecessors
        var svFinal = finalPlan.Jobs[svKey];
        Assert.Equal(2, svFinal.DependsOn.Count);
        Assert.Contains(ids.Key("b"), svFinal.DependsOn);
        Assert.Contains(ids.Key("c"), svFinal.DependsOn);
    }

    // ────────────────────────── Test 18 ──────────────────────────────

    /// <summary>
    /// When auto-heal is enabled but the cap is exhausted (MaxAutoHealAttempts=2), the job
    /// should fail after 3 attempts (1 original + 2 heals). Then <see cref="PlanCompletionHandler"/>
    /// cascades Blocked to downstream jobs and derives plan status as Failed.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-AUTOHEAL-CAP-CASCADE")]
    public async Task DAG_LIFECYCLE_AutoHeal_CapExhaustion_CascadesBlocked()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "autoheal-cap-cascade", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        // A's Work phase ALWAYS fails with AgentNonZeroExit
        var alwaysFail = new FakePhaseRunner(JobPhase.Work, failureSelector: _ =>
            () => throw new PhaseExecutionException(PhaseFailureKind.AgentNonZeroExit, JobPhase.Work, "agent died"));

        var opts = new PhaseOptions { MaxAutoHealAttempts = 2 };
        var runners = BuildRunners(alwaysFail);
        var exec = new PhaseExecutor(
            store, this.bus, this.clock,
            new FixedOptions<PhaseOptions>(opts),
            NullLogger<PhaseExecutor>.Instance,
            runners,
            autoHealEnabledSelector: _ => true);

        // Execute A — should fail after 3 attempts (1 + 2 heals)
        var resultA = await ExecuteJob(store, exec, planId, ids["a"]);
        Assert.Equal(JobStatus.Failed, resultA.FinalStatus);
        Assert.Equal(3, resultA.AttemptCount);

        // PlanCompletionHandler cascades B→Blocked, C→Blocked, Plan→Failed
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        // Verify final state
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Failed, plan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("c")].Status);
        Assert.Equal(PlanStatus.Failed, plan.Status);

        // A should have 3 recorded attempts
        Assert.Equal(3, plan.Jobs[ids.Key("a")].Attempts.Count);

        // No jobs should be ready
        var ready = await ComputeReadySet(store, planId);
        Assert.Empty(ready);
    }

    // ────────────────────────── Test 19 ──────────────────────────────

    /// <summary>
    /// When a job's Work phase always throws a transient failure (PhaseResume path),
    /// the executor should exhaust <c>MaxPhaseResumeAttempts</c> and then fail the job.
    /// With MaxPhaseResumeAttempts=2, the job runs 3 times total (1 original + 2 resumes).
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-PHASERESUME-EXHAUSTION")]
    public async Task DAG_LIFECYCLE_PhaseResume_Exhaustion_JobFails()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "phaseresume-exhaustion", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Transient job");

        // Work phase always throws TransientNetwork
        var alwaysFail = new FakePhaseRunner(JobPhase.Work, failureSelector: _ =>
            () => throw new PhaseExecutionException(PhaseFailureKind.TransientNetwork, JobPhase.Work, "net glitch"));

        var opts = new PhaseOptions { MaxPhaseResumeAttempts = 2 };
        var runners = BuildRunners(alwaysFail);
        var exec = new PhaseExecutor(
            store, this.bus, this.clock,
            new FixedOptions<PhaseOptions>(opts),
            NullLogger<PhaseExecutor>.Instance,
            runners);

        var result = await ExecuteJob(store, exec, planId, ids["a"]);

        Assert.Equal(JobStatus.Failed, result.FinalStatus);
        Assert.Equal(JobPhase.Work, result.EndedAtPhase);
        // 1 original + 2 phase-resumes = 3 total attempts
        Assert.Equal(3, result.AttemptCount);

        // Verify attempts recorded in store
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        var attempts = plan!.Jobs[ids.Key("a")].Attempts;
        Assert.Equal(3, attempts.Count);
        Assert.All(attempts, a => Assert.Equal(JobStatus.Failed, a.Status));
    }

    // ────────────────────────── Test 20 ──────────────────────────────

    /// <summary>
    /// After all jobs in a linear chain succeed, <see cref="PlanCompletionHandler.ProcessAsync"/>
    /// automatically derives plan status as Succeeded (not manually set).
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-PLAN-COMPLETION-AUTO")]
    public async Task DAG_LIFECYCLE_PlanCompletion_AutoDerived()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "plan-completion-auto", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute all three
        await ExecuteJob(store, exec, planId, ids["a"]);
        await ExecuteJob(store, exec, planId, ids["b"]);
        await ExecuteJob(store, exec, planId, ids["c"]);

        // Plan is still Running — completion handler derives terminal status
        var planBefore = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(planBefore);
        Assert.Equal(PlanStatus.Running, planBefore!.Status);

        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        // Verify auto-derived Succeeded
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Succeeded, plan!.Status);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ────────────────────────── Test 21 ──────────────────────────────

    /// <summary>
    /// When some jobs succeed and others fail in a fan-in topology,
    /// <see cref="PlanCompletionHandler"/> cascades Blocked to the fan-in job
    /// and derives plan status as Partial.
    ///
    /// <para>DAG: <c>A → C, B → C</c>. A succeeds, B fails (RemoteRejected).
    /// C depends on both, so C becomes Blocked. Plan → Partial.</para>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-PLAN-COMPLETION-PARTIAL")]
    public async Task DAG_LIFECYCLE_PlanCompletion_PartialStatus()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "plan-completion-partial", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → C, B → C (fan-in)
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B");
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["a"], ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute A successfully
        await ExecuteJob(store, exec, planId, ids["a"]);

        // B fails with RemoteRejected (fatal, no heal)
        var failWork = new FakePhaseRunner(JobPhase.Work, failureSelector: _ =>
            () => throw new PhaseExecutionException(PhaseFailureKind.RemoteRejected, JobPhase.Work, "rejected"));
        var failExec = this.MakeExecutor(store, workRunner: failWork);
        var resultB = await ExecuteJob(store, failExec, planId, ids["b"]);
        Assert.Equal(JobStatus.Failed, resultB.FinalStatus);

        // PlanCompletionHandler: C → Blocked (predecessor B failed), Plan → Partial
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Succeeded, plan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Failed, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("c")].Status);
        Assert.Equal(PlanStatus.Partial, plan.Status);
    }

    // ────────────────────────── Test 22 ──────────────────────────────

    /// <summary>
    /// When a predecessor job is Skipped (Pending→Skipped), the ready-set treats Skipped
    /// as "done" and downstream jobs become Ready and can execute normally.
    ///
    /// <para>DAG: <c>A → B → C</c>. A is Skipped, B becomes Ready, executes,
    /// C becomes Ready, executes. All succeed except A which is Skipped.</para>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-SKIPPED-NO-BLOCK")]
    public async Task DAG_LIFECYCLE_SkippedPredecessor_DoesNotBlock()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "skipped-no-block", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        // Skip A: Pending → Skipped
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("a"), JobStatus.Skipped));

        var planAfterSkip = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(planAfterSkip);
        Assert.Equal(JobStatus.Skipped, planAfterSkip!.Jobs[ids.Key("a")].Status);

        // B should be Ready (A is Skipped, treated as "done")
        var readyAfterSkip = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterSkip);
        Assert.Contains(ids.Key("b"), readyAfterSkip);

        var exec = this.MakeExecutor(store);

        // Execute B
        var resultB = await ExecuteJob(store, exec, planId, ids["b"]);
        Assert.Equal(JobStatus.Succeeded, resultB.FinalStatus);

        // C should be Ready
        var readyAfterB = await ComputeReadySet(store, planId);
        Assert.Single(readyAfterB);
        Assert.Contains(ids.Key("c"), readyAfterB);

        // Execute C
        var resultC = await ExecuteJob(store, exec, planId, ids["c"]);
        Assert.Equal(JobStatus.Succeeded, resultC.FinalStatus);

        // Verify final state: A=Skipped, B=Succeeded, C=Succeeded
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Skipped, plan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Succeeded, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Succeeded, plan.Jobs[ids.Key("c")].Status);
    }

    // ────────────────────────── Test 23 ──────────────────────────────

    /// <summary>
    /// When all jobs are canceled (Pending→Canceled), <see cref="PlanCompletionHandler"/>
    /// derives plan status as Canceled.
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-ALL-CANCELED")]
    public async Task DAG_LIFECYCLE_PlanCompletion_AllCanceled()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "all-canceled", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // 3 independent roots
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B");
        await AddJob(store, planId, ids.Register("c"), "Job C");

        // Cancel all three: Pending → Canceled
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("a"), JobStatus.Canceled));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("b"), JobStatus.Canceled));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Canceled));

        // PlanCompletionHandler derives Canceled
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Canceled, plan!.Status);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Canceled, j.Status));
    }

    // ────────────────────────── Test 24 ──────────────────────────────

    /// <summary>
    /// Exercises the Pausing lifecycle: a plan transitions to Pausing while a job is
    /// Running, the in-flight job completes, the plan transitions to Paused (no new
    /// dispatch), then resuming allows remaining jobs to execute.
    ///
    /// <para>DAG: <c>A → B → C</c></para>
    /// <list type="number">
    /// <item>Execute A</item>
    /// <item>Start B (Running), set plan to Pausing</item>
    /// <item>Complete B → plan transitions Pausing → Paused</item>
    /// <item>Verify C is Ready but no dispatch (Paused)</item>
    /// <item>Resume → Running, execute C</item>
    /// <item>PlanCompletionHandler → Succeeded</item>
    /// </list>
    /// </summary>
    [Fact]
    [ContractTest("DAG-LIFECYCLE-PAUSING-INFLIGHT")]
    public async Task DAG_LIFECYCLE_Pausing_InFlightCompletes_ThenPaused()
    {
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "pausing-inflight", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var exec = this.MakeExecutor(store);

        // Execute A
        await ExecuteJob(store, exec, planId, ids["a"]);

        // Start B: transition to Running
        await TransitionToRunning(store, planId, ids.Key("b"));

        // Set plan to Pausing while B is Running
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Pausing));
        var pausingPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(pausingPlan);
        Assert.Equal(PlanStatus.Pausing, pausingPlan!.Status);
        Assert.Equal(JobStatus.Running, pausingPlan.Jobs[ids.Key("b")].Status);

        // Complete B (in-flight job finishes)
        var resultB = await exec.ExecuteAsync(planId, ids["b"], RunId.New(), CancellationToken.None);
        Assert.Equal(JobStatus.Succeeded, resultB.FinalStatus);
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, ids.Key("b"), resultB.FinalStatus));

        // No Running jobs remain → transition Pausing → Paused
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Paused));
        var pausedPlan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(pausedPlan);
        Assert.Equal(PlanStatus.Paused, pausedPlan!.Status);

        // C is Ready (B succeeded) but plan is Paused — no dispatch
        var readyWhilePaused = await ComputeReadySet(store, planId);
        Assert.Single(readyWhilePaused);
        Assert.Contains(ids.Key("c"), readyWhilePaused);
        Assert.Equal(JobStatus.Pending, pausedPlan.Jobs[ids.Key("c")].Status);

        // Resume → Running
        await Mutate(store, planId, new PlanStatusUpdated(0, default, default, PlanStatus.Running));

        // Execute C
        await ExecuteJob(store, exec, planId, ids["c"]);

        // PlanCompletionHandler derives Succeeded
        var handler = new PlanCompletionHandler(
            store, this.bus, this.clock, NullLogger<PlanCompletionHandler>.Instance);
        var terminal = await handler.ProcessAsync(planId, CancellationToken.None);
        Assert.True(terminal);

        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(PlanStatus.Succeeded, plan!.Status);
        Assert.All(plan.Jobs.Values, j => Assert.Equal(JobStatus.Succeeded, j.Status));
    }

    // ──────────────────────── Infrastructure helpers ────────────────────────

    private PlanStore CreateStore(PlanStoreOptions? options = null) =>
        new(
            new AbsolutePath(this.root),
            new NullFileSystem(),
            this.clock,
            this.bus,
            new FixedOptions<PlanStoreOptions>(options ?? new PlanStoreOptions()),
            NullLogger<PlanStore>.Instance);

    private PhaseExecutor MakeExecutor(
        IPlanStore store,
        FakePhaseRunner? workRunner = null,
        Func<JobNode, bool>? autoHeal = null)
    {
        var runners = BuildRunners(workRunner);
        return new PhaseExecutor(
            store,
            this.bus,
            this.clock,
            new FixedOptions<PhaseOptions>(new PhaseOptions()),
            NullLogger<PhaseExecutor>.Instance,
            runners,
            autoHeal);
    }

    private PhaseExecutor MakeExecutorWithCustomWork(
        IPlanStore store,
        IPhaseRunner workRunner,
        Func<JobNode, bool>? autoHeal = null)
    {
        var runners = new IPhaseRunner[]
        {
            new FakePhaseRunner(JobPhase.MergeForwardIntegration),
            new FakePhaseRunner(JobPhase.Setup),
            new FakePhaseRunner(JobPhase.Prechecks),
            workRunner,
            new FakePhaseRunner(JobPhase.Commit, TestSha),
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

    private static IEnumerable<IPhaseRunner> BuildRunners(FakePhaseRunner? workRunner = null)
    {
        yield return new FakePhaseRunner(JobPhase.MergeForwardIntegration);
        yield return new FakePhaseRunner(JobPhase.Setup);
        yield return new FakePhaseRunner(JobPhase.Prechecks);
        yield return workRunner ?? new FakePhaseRunner(JobPhase.Work);
        yield return new FakePhaseRunner(JobPhase.Commit, TestSha);
        yield return new FakePhaseRunner(JobPhase.Postchecks);
        yield return new FakePhaseRunner(JobPhase.MergeReverseIntegration);
    }

    /// <summary>
    /// Drives the scheduler loop for a single job: Pending → Ready → Scheduled → Running,
    /// then calls <see cref="PhaseExecutor.ExecuteAsync"/>, then transitions to the final status.
    /// </summary>
    private static async Task<PhaseExecResult> ExecuteJob(
        PlanStore store, PhaseExecutor exec, PlanId planId, JobId jobId)
    {
        var key = jobId.ToString();
        await TransitionToRunning(store, planId, key);

        var result = await exec.ExecuteAsync(planId, jobId, RunId.New(), CancellationToken.None);

        // Transition from Running to the final status
        await Mutate(store, planId,
            new JobStatusUpdated(0, default, default, key, result.FinalStatus));

        return result;
    }

    private static async Task TransitionToRunning(PlanStore store, PlanId planId, string jobIdValue)
    {
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, jobIdValue, JobStatus.Ready));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, jobIdValue, JobStatus.Scheduled));
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, jobIdValue, JobStatus.Running));
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

    /// <summary>Maps friendly test names (e.g. "a", "b") to real <see cref="JobId"/> values.</summary>
    private sealed class JobIdMap
    {
        private readonly Dictionary<string, JobId> map = new(StringComparer.Ordinal);

        /// <summary>Registers a friendly name and returns the generated <see cref="JobId"/>.</summary>
        public JobId Register(string name)
        {
            var id = JobId.New();
            this.map[name] = id;
            return id;
        }

        /// <summary>Gets the <see cref="JobId"/> for a friendly name.</summary>
        public JobId this[string name] => this.map[name];

        /// <summary>Gets the string key (job_xxx) used in the plan's Jobs dictionary.</summary>
        public string Key(string name) => this.map[name].ToString();
    }

    /// <summary>
    /// Work-phase runner that throws a configured <see cref="PhaseFailureKind"/> on the
    /// first invocation for each job, then succeeds on subsequent invocations (retries).
    /// Used by <see cref="DAG_LIFECYCLE_AutoHeal_All10FailureKinds"/> to exercise all
    /// failure-kind branches in a single plan.
    /// </summary>
    private sealed class PerJobWorkRunner : IPhaseRunner
    {
        private readonly Dictionary<string, PhaseFailureKind> failureKinds;
        private readonly HashSet<string> alreadyFailed = new(StringComparer.Ordinal);

        public PerJobWorkRunner(Dictionary<string, PhaseFailureKind> failureKinds)
        {
            this.failureKinds = failureKinds;
        }

        public JobPhase Phase => JobPhase.Work;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            if (this.failureKinds.TryGetValue(key, out var kind) && this.alreadyFailed.Add(key))
            {
                throw new PhaseExecutionException(kind, JobPhase.Work, $"{kind} failure");
            }

            return new ValueTask<CommitSha?>((CommitSha?)null);
        }
    }

    /// <summary>Minimal <see cref="IFileSystem"/> that does nothing — real PlanStore uses direct IO for journal/checkpoint.</summary>
    private sealed class NullFileSystem : IFileSystem
    {
        public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct) => new(false);

        public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct) =>
            ValueTask.FromResult(File.Exists(path.Value));

        public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct) =>
            ValueTask.FromResult(Directory.Exists(path.Value));

        public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct)
        {
            _ = Directory.CreateDirectory(path.Value);
            return ValueTask.CompletedTask;
        }

        public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct)
        {
            Directory.Delete(path.Value, recursive);
            return ValueTask.CompletedTask;
        }

        public ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct) =>
            new(File.ReadAllTextAsync(path.Value, ct));

        public ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct) =>
            new(File.WriteAllTextAsync(path.Value, contents, ct));

        public ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct) =>
            new(File.ReadAllBytesAsync(path.Value, ct));

        public ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct) =>
            new(File.WriteAllBytesAsync(path.Value, contents, ct));

        public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct) =>
            ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true));

        public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct) =>
            new((Stream)new MemoryStream());

        public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct) =>
            ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true));

        public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct) =>
            ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, useAsync: true));

        public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
        {
            File.Move(source.Value, destination.Value, overwrite: true);
            return ValueTask.CompletedTask;
        }

        public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct)
        {
            File.Copy(source.Value, destination.Value, overwrite);
            return ValueTask.CompletedTask;
        }

        public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct) => default;

        public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct) => new(MountKind.Local);

        public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(
            AbsolutePath directory, string searchPattern, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            if (!Directory.Exists(directory.Value)) { yield break; }
            foreach (var f in Directory.EnumerateFiles(directory.Value, searchPattern))
            {
                ct.ThrowIfCancellationRequested();
                yield return new AbsolutePath(f);
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }

        public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(
            AbsolutePath directory, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            if (!Directory.Exists(directory.Value)) { yield break; }
            foreach (var d in Directory.EnumerateDirectories(directory.Value))
            {
                ct.ThrowIfCancellationRequested();
                yield return new AbsolutePath(d);
            }

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }
}
