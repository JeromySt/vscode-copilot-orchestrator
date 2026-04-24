// <copyright file="DagLifecycleIntegrationTests.cs" company="AiOrchestrator contributors">
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
                job.DependsOn.All(d => plan.Jobs.TryGetValue(d, out var dep) && dep.Status == JobStatus.Succeeded))
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

    /// <summary>Minimal <see cref="IFileSystem"/> that does nothing — real PlanStore uses direct IO for journal/checkpoint.</summary>
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
