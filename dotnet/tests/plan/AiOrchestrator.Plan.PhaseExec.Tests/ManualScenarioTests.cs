// <copyright file="ManualScenarioTests.cs" company="AiOrchestrator contributors">
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
/// End-to-end tests that exercise real git operations through the DAG execution pipeline.
/// Each test creates a REAL git repository, creates worktrees for each job, has the Work
/// phase write actual files, CommitPhase commits them, and at the end verifies the files
/// exist on the target branch.
/// </summary>
[Trait("Category", "ManualScenario")]
public sealed class ManualScenarioTests : IDisposable
{
    private readonly string storeRoot;
    private readonly InMemoryClock clock;
    private readonly RecordingEventBus bus;

    public ManualScenarioTests()
    {
        this.storeRoot = Path.Combine(Path.GetTempPath(), "manual-scenario", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.storeRoot);
        this.clock = new InMemoryClock();
        this.bus = new RecordingEventBus();
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.storeRoot))
            {
                Directory.Delete(this.storeRoot, recursive: true);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    // ────────────────────────────── Test 1 ──────────────────────────────

    [Fact]
    [ContractTest("MANUAL-SCENARIO-LINEAR")]
    public async Task MANUAL_SCENARIO_LinearChain_FilesOnTargetBranch()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "linear-e2e", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("a")] = ("a.txt", "content-from-job-a"),
            [ids.Key("b")] = ("b.txt", "content-from-job-b"),
            [ids.Key("c")] = ("c.txt", "content-from-job-c"),
        };

        var exec = this.MakeGitExecutor(store, fixture, fileMap);

        // Execute A → B → C in sequence
        foreach (var name in new[] { "a", "b", "c" })
        {
            fixture.CreateWorktree(ids.Key(name));

            var ready = await ComputeReadySet(store, planId);
            Assert.Contains(ids.Key(name), ready);

            var result = await ExecuteJob(store, exec, planId, ids[name]);
            Assert.Equal(JobStatus.Succeeded, result.FinalStatus);

            fixture.MergeWorktreeToMain(ids.Key(name));
        }

        // Verify all 3 files exist on main
        Assert.True(fixture.VerifyFileOnBranch("main", "a.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "b.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "c.txt"));
    }

    // ────────────────────────────── Test 2 ──────────────────────────────

    [Fact]
    [ContractTest("MANUAL-SCENARIO-FANOUT-FANIN")]
    public async Task MANUAL_SCENARIO_FanOutFanIn_AllFilesOnTarget()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "fanout-e2e", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Root → {W1, W2, W3} → Verify
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("root"), "Root");
        await AddJob(store, planId, ids.Register("w1"), "Worker 1", ids["root"]);
        await AddJob(store, planId, ids.Register("w2"), "Worker 2", ids["root"]);
        await AddJob(store, planId, ids.Register("w3"), "Worker 3", ids["root"]);
        await AddJob(store, planId, ids.Register("verify"), "Verify", ids["w1"], ids["w2"], ids["w3"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("root")] = ("root.txt", "root-content"),
            [ids.Key("w1")] = ("w1.txt", "w1-content"),
            [ids.Key("w2")] = ("w2.txt", "w2-content"),
            [ids.Key("w3")] = ("w3.txt", "w3-content"),
            [ids.Key("verify")] = ("verified.txt", "all-verified"),
        };

        var exec = this.MakeGitExecutor(store, fixture, fileMap);

        // Execute Root
        fixture.CreateWorktree(ids.Key("root"));
        var rootResult = await ExecuteJob(store, exec, planId, ids["root"]);
        Assert.Equal(JobStatus.Succeeded, rootResult.FinalStatus);
        fixture.MergeWorktreeToMain(ids.Key("root"));

        // Fan-out: W1, W2, W3 all ready
        var readyFanOut = await ComputeReadySet(store, planId);
        Assert.Equal(3, readyFanOut.Count);

        // Execute W1, W2, W3
        foreach (var name in new[] { "w1", "w2", "w3" })
        {
            fixture.CreateWorktree(ids.Key(name));
            var result = await ExecuteJob(store, exec, planId, ids[name]);
            Assert.Equal(JobStatus.Succeeded, result.FinalStatus);
            fixture.MergeWorktreeToMain(ids.Key(name));
        }

        // Verify job ready
        var readyVerify = await ComputeReadySet(store, planId);
        Assert.Single(readyVerify);
        Assert.Contains(ids.Key("verify"), readyVerify);

        fixture.CreateWorktree(ids.Key("verify"));
        var verifyResult = await ExecuteJob(store, exec, planId, ids["verify"]);
        Assert.Equal(JobStatus.Succeeded, verifyResult.FinalStatus);
        fixture.MergeWorktreeToMain(ids.Key("verify"));

        // Verify all files on main
        Assert.True(fixture.VerifyFileOnBranch("main", "root.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "w1.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "w2.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "w3.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "verified.txt"));
    }

    // ────────────────────────────── Test 3 ──────────────────────────────

    [Fact]
    [ContractTest("MANUAL-SCENARIO-DIAMOND")]
    public async Task MANUAL_SCENARIO_DiamondDag_MergeConflictFree()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "diamond-e2e", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → C, B → C, C → D (A and B are independent roots)
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Root A");
        await AddJob(store, planId, ids.Register("b"), "Root B");
        await AddJob(store, planId, ids.Register("c"), "Fan-in C", ids["a"], ids["b"]);
        await AddJob(store, planId, ids.Register("d"), "Leaf D", ids["c"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("a")] = ("a/file.txt", "a-content"),
            [ids.Key("b")] = ("b/file.txt", "b-content"),
            [ids.Key("c")] = ("c/file.txt", "c-content"),
            [ids.Key("d")] = ("d/file.txt", "d-content"),
        };

        var exec = this.MakeGitExecutor(store, fixture, fileMap);

        // A and B are both ready
        var ready0 = await ComputeReadySet(store, planId);
        Assert.Equal(2, ready0.Count);

        // Execute A
        fixture.CreateWorktree(ids.Key("a"));
        await ExecuteJob(store, exec, planId, ids["a"]);
        fixture.MergeWorktreeToMain(ids.Key("a"));

        // Execute B
        fixture.CreateWorktree(ids.Key("b"));
        await ExecuteJob(store, exec, planId, ids["b"]);
        fixture.MergeWorktreeToMain(ids.Key("b"));

        // C ready (both A and B succeeded)
        var readyC = await ComputeReadySet(store, planId);
        Assert.Single(readyC);
        Assert.Contains(ids.Key("c"), readyC);

        fixture.CreateWorktree(ids.Key("c"));
        await ExecuteJob(store, exec, planId, ids["c"]);
        fixture.MergeWorktreeToMain(ids.Key("c"));

        // D ready
        fixture.CreateWorktree(ids.Key("d"));
        await ExecuteJob(store, exec, planId, ids["d"]);
        fixture.MergeWorktreeToMain(ids.Key("d"));

        // Verify all 4 files on main (different directories = no conflicts)
        Assert.True(fixture.VerifyFileOnBranch("main", "a/file.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "b/file.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "c/file.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "d/file.txt"));
    }

    // ────────────────────────────── Test 4 ──────────────────────────────

    [Fact]
    [ContractTest("MANUAL-SCENARIO-SPLIT-FANIN")]
    public async Task MANUAL_SCENARIO_SplitAndFanIn_NestedFiles()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "split-fanin-e2e", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // Initial: Root → Work → Final
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("root"), "Root");
        await AddJob(store, planId, ids.Register("work"), "Work", ids["root"]);
        await AddJob(store, planId, ids.Register("final"), "Final", ids["work"]);

        // We'll add W1, W2 (depending on Work), WV (depending on W1+W2) via reshape,
        // then rewire Final to depend on WV.
        var allFiles = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("root")] = ("root.txt", "root-content"),
            [ids.Key("work")] = ("work-partial.txt", "work-partial-content"),
        };

        var exec = this.MakeGitExecutor(store, fixture, allFiles);

        // Execute Root
        fixture.CreateWorktree(ids.Key("root"));
        await ExecuteJob(store, exec, planId, ids["root"]);
        fixture.MergeWorktreeToMain(ids.Key("root"));

        // Execute Work (simulates partial completion)
        fixture.CreateWorktree(ids.Key("work"));
        await ExecuteJob(store, exec, planId, ids["work"]);
        fixture.MergeWorktreeToMain(ids.Key("work"));

        // Reshape: add W1, W2 depending on Work; WV depending on W1+W2; rewire Final→WV
        var w1Id = ids.Register("w1");
        var w2Id = ids.Register("w2");
        var wvId = ids.Register("wv");

        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = w1Id.ToString(),
                Title = "W1",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("work") },
                WorkSpec = new WorkSpec { Instructions = "Split chunk 1" },
            }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = w2Id.ToString(),
                Title = "W2",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("work") },
                WorkSpec = new WorkSpec { Instructions = "Split chunk 2" },
            }));
        await Mutate(store, planId, new JobAdded(0, default, default,
            new JobNode
            {
                Id = wvId.ToString(),
                Title = "WV",
                Status = JobStatus.Pending,
                DependsOn = new[] { ids.Key("w1"), ids.Key("w2") },
                WorkSpec = new WorkSpec { Instructions = "Verify split" },
            }));
        await Mutate(store, planId, new JobDepsUpdated(0, default, default,
            ids.Key("final"),
            System.Collections.Immutable.ImmutableArray.Create(ids.Key("wv"))));

        // Register files for the new jobs
        allFiles[ids.Key("w1")] = ("w1.txt", "w1-content");
        allFiles[ids.Key("w2")] = ("w2.txt", "w2-content");
        allFiles[ids.Key("wv")] = ("verified.txt", "verified-content");
        allFiles[ids.Key("final")] = ("final.txt", "final-content");

        // Rebuild executor with updated file map
        exec = this.MakeGitExecutor(store, fixture, allFiles);

        // W1 and W2 both ready (Work succeeded)
        var readyW = await ComputeReadySet(store, planId);
        Assert.Equal(2, readyW.Count);

        // Execute W1, W2
        foreach (var name in new[] { "w1", "w2" })
        {
            fixture.CreateWorktree(ids.Key(name));
            await ExecuteJob(store, exec, planId, ids[name]);
            fixture.MergeWorktreeToMain(ids.Key(name));
        }

        // WV ready
        fixture.CreateWorktree(ids.Key("wv"));
        await ExecuteJob(store, exec, planId, ids["wv"]);
        fixture.MergeWorktreeToMain(ids.Key("wv"));

        // Final ready
        fixture.CreateWorktree(ids.Key("final"));
        await ExecuteJob(store, exec, planId, ids["final"]);
        fixture.MergeWorktreeToMain(ids.Key("final"));

        // Verify all 6 files on main
        Assert.True(fixture.VerifyFileOnBranch("main", "root.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "work-partial.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "w1.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "w2.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "verified.txt"));
        Assert.True(fixture.VerifyFileOnBranch("main", "final.txt"));
    }

    // ────────────────────────────── Test 5 ──────────────────────────────

    [Fact]
    [ContractTest("MANUAL-SCENARIO-FAILED-PARTIAL")]
    public async Task MANUAL_SCENARIO_FailedJob_PartialMerge()
    {
        using var fixture = new GitTestFixture();
        await using var store = this.CreateStore();
        var planId = await store.CreateAsync(
            new PlanModel { Name = "fail-partial-e2e", Status = PlanStatus.Running },
            Idem(), CancellationToken.None);

        // A → B → C
        var ids = new JobIdMap();
        await AddJob(store, planId, ids.Register("a"), "Job A");
        await AddJob(store, planId, ids.Register("b"), "Job B", ids["a"]);
        await AddJob(store, planId, ids.Register("c"), "Job C", ids["b"]);

        var fileMap = new Dictionary<string, (string FileName, string Content)>
        {
            [ids.Key("a")] = ("a.txt", "content-from-job-a"),
            [ids.Key("b")] = ("b.txt", "content-from-job-b"),
            [ids.Key("c")] = ("c.txt", "content-from-job-c"),
        };

        // A succeeds normally
        var exec = this.MakeGitExecutor(store, fixture, fileMap);
        fixture.CreateWorktree(ids.Key("a"));
        var resultA = await ExecuteJob(store, exec, planId, ids["a"]);
        Assert.Equal(JobStatus.Succeeded, resultA.FinalStatus);
        fixture.MergeWorktreeToMain(ids.Key("a"));

        // B: use a failing work runner that writes the file but then throws
        var failingFileMap = new Dictionary<string, (string FileName, string Content)>(fileMap);
        var failExec = this.MakeFailingGitExecutor(store, fixture, failingFileMap, ids.Key("b"));

        fixture.CreateWorktree(ids.Key("b"));
        var resultB = await ExecuteJob(store, failExec, planId, ids["b"]);
        Assert.Equal(JobStatus.Failed, resultB.FinalStatus);
        // B's worktree is NOT merged to main

        // C → Blocked
        await Mutate(store, planId, new JobStatusUpdated(0, default, default, ids.Key("c"), JobStatus.Blocked));

        // Verify: a.txt IS on main (A merged), but b.txt is NOT (B never merged)
        Assert.True(fixture.VerifyFileOnBranch("main", "a.txt"));
        Assert.False(fixture.VerifyFileOnBranch("main", "b.txt"));
        Assert.False(fixture.VerifyFileOnBranch("main", "c.txt"));

        // Verify plan state
        var plan = await store.LoadAsync(planId, CancellationToken.None);
        Assert.NotNull(plan);
        Assert.Equal(JobStatus.Succeeded, plan!.Jobs[ids.Key("a")].Status);
        Assert.Equal(JobStatus.Failed, plan.Jobs[ids.Key("b")].Status);
        Assert.Equal(JobStatus.Blocked, plan.Jobs[ids.Key("c")].Status);
    }

    // ──────────────────────── Infrastructure helpers ────────────────────────

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

    private static async Task<PhaseExecResult> ExecuteJob(
        PlanStore store, PhaseExecutor exec, PlanId planId, JobId jobId)
    {
        var key = jobId.ToString();
        await TransitionToRunning(store, planId, key);

        var result = await exec.ExecuteAsync(planId, jobId, RunId.New(), CancellationToken.None);

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
            this.repoPath = Path.Combine(Path.GetTempPath(), "git-scenario", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.repoPath);

            // Initialize a real git repo with an initial commit on main
            RunGit(this.repoPath, "init", "-b", "main");
            RunGit(this.repoPath, "config", "user.email", "test@test.com");
            RunGit(this.repoPath, "config", "user.name", "Test");

            // Create initial commit so main branch exists
            var initFile = Path.Combine(this.repoPath, ".gitkeep");
            File.WriteAllText(initFile, "init");
            RunGit(this.repoPath, "add", ".");
            RunGit(this.repoPath, "commit", "-m", "Initial commit");

            // Ensure orchestrator .gitignore entries are committed before any plan execution
            AiOrchestrator.Git.Gitignore.GitignoreCommitter
                .EnsureAndCommitAsync(this.repoPath)
                .GetAwaiter().GetResult();
        }

        public string RepoPath => this.repoPath;

        public void CreateWorktree(string jobKey)
        {
            var safeName = SanitizeBranchName(jobKey);
            var branchName = $"job/{safeName}";
            var worktreePath = Path.Combine(this.repoPath, ".worktrees", safeName);

            RunGit(this.repoPath, "worktree", "add", worktreePath, "-b", branchName);

            // Copy git config to worktree so commits work
            RunGit(worktreePath, "config", "user.email", "test@test.com");
            RunGit(worktreePath, "config", "user.name", "Test");

            this.worktreePaths[jobKey] = worktreePath;
            this.worktreeBranches[jobKey] = branchName;
        }

        public string GetWorktreePath(string jobKey) =>
            this.worktreePaths.TryGetValue(jobKey, out var path)
                ? path
                : throw new InvalidOperationException($"No worktree created for job key '{jobKey}'");

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
                : throw new InvalidOperationException($"No worktree branch for job key '{jobKey}'");

            // Checkout main, merge the branch
            RunGit(this.repoPath, "checkout", "main");
            RunGit(this.repoPath, "merge", branchName, "--no-ff", "-m", $"Merge {branchName}");
        }

        public bool VerifyFileOnBranch(string branch, string filename)
        {
            // Use git show to check file existence on branch without switching
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

        public void Dispose()
        {
            try
            {
                // Remove worktrees first
                foreach (var (_, wtPath) in this.worktreePaths)
                {
                    try
                    {
                        RunGit(this.repoPath, "worktree", "remove", wtPath, "--force");
                    }
                    catch
                    {
                        // best-effort
                    }
                }

                // Force-remove the temp directory
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

        private static void ForceDeleteDirectory(string path)
        {
            // Remove read-only attributes that git sets on .git objects
            foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
            {
                try
                {
                    File.SetAttributes(file, FileAttributes.Normal);
                }
                catch
                {
                    // ignore
                }
            }

            Directory.Delete(path, recursive: true);
        }
    }

    // ──────────────────── Real Phase Runners ────────────────────

    /// <summary>
    /// Work-phase runner that writes a file in the job's worktree and stages it.
    /// </summary>
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

    /// <summary>
    /// Commit-phase runner that commits staged changes in the job's worktree.
    /// </summary>
    private sealed class RealCommitPhaseRunner : IPhaseRunner
    {
        private readonly GitTestFixture fixture;

        public RealCommitPhaseRunner(GitTestFixture fixture)
        {
            this.fixture = fixture;
        }

        public JobPhase Phase => JobPhase.Commit;

        public ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
        {
            var key = ctx.JobId.ToString();
            var sha = this.fixture.CommitInWorktree(key, $"Job {key}");
            return new ValueTask<CommitSha?>(new CommitSha(sha));
        }
    }

    /// <summary>
    /// Work-phase runner that writes files normally but throws for a specific job,
    /// simulating a failed job that has written but not committed its work.
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
                    "Simulated failure for job " + key);
            }

            return new ValueTask<CommitSha?>((CommitSha?)null);
        }
    }

    // ──────────────────── Reused from DagLifecycleIntegrationTests ────────────────────

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
