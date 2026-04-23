// <copyright file="DagLifecycleIntegrationTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
