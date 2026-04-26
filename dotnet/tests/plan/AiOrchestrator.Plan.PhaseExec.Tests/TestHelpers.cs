// <copyright file="TestHelpers.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipelines;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Plan.Models;
using AiOrchestrator.Plan.PhaseExec.Phases;
using AiOrchestrator.Plan.Store;
using Microsoft.Extensions.Options;
using SysProcess = System.Diagnostics.Process;

namespace AiOrchestrator.Plan.PhaseExec.Tests;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "PHASE-ORDER").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}

/// <summary>Records all events published, in order.</summary>
internal sealed class RecordingEventBus : IEventBus
{
    private readonly List<object> published = [];
    private readonly object syncRoot = new();

    public IReadOnlyList<T> Of<T>()
    {
        lock (this.syncRoot)
        {
            return this.published.OfType<T>().ToList();
        }
    }

    public ValueTask PublishAsync<TEvent>(TEvent eventData, CancellationToken ct)
        where TEvent : notnull
    {
        lock (this.syncRoot)
        {
            this.published.Add(eventData);
        }

        return ValueTask.CompletedTask;
    }

    public IAsyncDisposable Subscribe<TEvent>(EventFilter filter, Func<TEvent, CancellationToken, ValueTask> handler)
        where TEvent : notnull => NullDisposable.Instance;

    private sealed class NullDisposable : IAsyncDisposable
    {
        public static readonly NullDisposable Instance = new();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

/// <summary>Simple <see cref="IOptionsMonitor{T}"/> that always returns a fixed value.</summary>
internal sealed class FixedOptions<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue => value;

    public T Get(string? name) => value;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}

/// <summary>Minimal <see cref="IPlanStore"/> for phase-executor contract tests.</summary>
internal sealed class StubPlanStore : IPlanStore
{
    private readonly Plan.Models.Plan plan;
    private readonly List<JobAttemptRecorded> recorded = [];

    public StubPlanStore(Plan.Models.Plan plan) => this.plan = plan;

    public IReadOnlyList<JobAttemptRecorded> Recorded
    {
        get
        {
            lock (this.recorded)
            {
                return [.. this.recorded];
            }
        }
    }

    public ValueTask<PlanId> CreateAsync(Plan.Models.Plan initialPlan, IdempotencyKey idemKey, CancellationToken ct) =>
        throw new NotSupportedException();

    public ValueTask<Plan.Models.Plan?> LoadAsync(PlanId id, CancellationToken ct) =>
        ValueTask.FromResult<Plan.Models.Plan?>(this.plan);

    public ValueTask MutateAsync(PlanId id, PlanMutation mutation, IdempotencyKey idemKey, CancellationToken ct)
    {
        if (mutation is JobAttemptRecorded jar)
        {
            lock (this.recorded)
            {
                this.recorded.Add(jar);
            }
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask CheckpointAsync(PlanId id, CancellationToken ct) => ValueTask.CompletedTask;

    public async IAsyncEnumerable<Plan.Models.Plan> ListAsync([EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Yield();
        yield return this.plan;
    }

    public async IAsyncEnumerable<PlanMutation> ReadJournalAsync(PlanId id, long fromSeq, [EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Yield();
        yield break;
    }

    public async IAsyncEnumerable<Plan.Models.Plan> WatchAsync(PlanId id, [EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Yield();
        yield return this.plan;
    }
}

/// <summary>
/// Configurable <see cref="IPhaseRunner"/> stub. Records every invocation in <see cref="Calls"/>;
/// fails on configured calls; otherwise succeeds. The Commit runner can produce a commit SHA.
/// </summary>
internal sealed class FakePhaseRunner : IPhaseRunner
{
    private readonly Func<int, Action?> failureSelector;
    private int callCount;

    public FakePhaseRunner(JobPhase phase, CommitSha? commitSha = null, Func<int, Action?>? failureSelector = null)
    {
        this.Phase = phase;
        this.CommitSha = commitSha;
        this.failureSelector = failureSelector ?? (_ => null);
    }

    public JobPhase Phase { get; }

    public CommitSha? CommitSha { get; }

    public List<int> Calls { get; } = [];

    public Func<CancellationToken, ValueTask>? OnRun { get; set; }

    public async ValueTask<CommitSha?> RunAsync(PhaseRunContext ctx, CancellationToken ct)
    {
        var n = Interlocked.Increment(ref this.callCount);
        this.Calls.Add(n);

        if (this.OnRun is not null)
        {
            await this.OnRun(ct).ConfigureAwait(false);
        }

        var fail = this.failureSelector(n);
        fail?.Invoke();

        return this.Phase == JobPhase.Commit ? this.CommitSha : null;
    }
}

/// <summary>Simple test fixtures.</summary>
internal static class Fixtures
{
    public static Plan.Models.Plan MakePlan(PlanId planId, JobId jobId, string title = "test-job")
    {
        var job = new JobNode { Id = jobId.ToString(), Title = title, Status = JobStatus.Pending };
        return new Plan.Models.Plan
        {
            Id = planId.ToString(),
            Jobs = new Dictionary<string, JobNode> { [job.Id] = job },
        };
    }

    public static IEnumerable<IPhaseRunner> AllPassRunners(out FakePhaseRunner commit, CommitSha? sha = null)
    {
        var mergeFi = new FakePhaseRunner(JobPhase.MergeForwardIntegration);
        var setup = new FakePhaseRunner(JobPhase.Setup);
        var pre = new FakePhaseRunner(JobPhase.Prechecks);
        var work = new FakePhaseRunner(JobPhase.Work);
        var post = new FakePhaseRunner(JobPhase.Postchecks);
        commit = new FakePhaseRunner(JobPhase.Commit, sha ?? new CommitSha("0000000000000000000000000000000000000000"));
        var mergeRi = new FakePhaseRunner(JobPhase.MergeReverseIntegration);
        return new IPhaseRunner[] { mergeFi, setup, pre, work, commit, post, mergeRi };
    }
}

/// <summary>
/// Minimal <see cref="IProcessSpawner"/> that starts real processes for integration tests.
/// </summary>
internal sealed class TestProcessSpawner : IProcessSpawner
{
    public ValueTask<IProcessHandle> SpawnAsync(ProcessSpec spec, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(spec.Executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var arg in spec.Arguments)
        {
            psi.ArgumentList.Add(arg);
        }

        var process = SysProcess.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {spec.Executable}");

        return ValueTask.FromResult<IProcessHandle>(new TestProcessHandle(process));
    }

    private sealed class TestProcessHandle : IProcessHandle
    {
        private readonly SysProcess process;
        private readonly Pipe outPipe = new();
        private readonly Pipe errPipe = new();
        private readonly Pipe inPipe = new();
        private readonly Task outPump;
        private readonly Task errPump;

        public TestProcessHandle(SysProcess process)
        {
            this.process = process;
            this.outPump = PumpAsync(process.StandardOutput.BaseStream, this.outPipe.Writer);
            this.errPump = PumpAsync(process.StandardError.BaseStream, this.errPipe.Writer);
        }

        public int ProcessId => this.process.Id;
        public PipeReader StandardOut => this.outPipe.Reader;
        public PipeReader StandardError => this.errPipe.Reader;
        public PipeWriter StandardIn => this.inPipe.Writer;

        public ValueTask<ProcessTreeNode?> GetProcessTreeAsync(CancellationToken ct) => ValueTask.FromResult<ProcessTreeNode?>(null);

        public async Task<int> WaitForExitAsync(CancellationToken ct)
        {
            await this.process.WaitForExitAsync(ct).ConfigureAwait(false);
            await Task.WhenAll(this.outPump, this.errPump).ConfigureAwait(false);
            return this.process.ExitCode;
        }

        public ValueTask SignalAsync(ProcessSignal signal, CancellationToken ct)
        {
            try { this.process.Kill(); }
            catch (InvalidOperationException) { }
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            this.process.Dispose();
            return ValueTask.CompletedTask;
        }

        private static async Task PumpAsync(Stream source, PipeWriter writer)
        {
            try
            {
                var buffer = new byte[4096];
                int bytesRead;
                while ((bytesRead = await source.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                {
                    await writer.WriteAsync(buffer.AsMemory(0, bytesRead)).ConfigureAwait(false);
                }
            }
            finally
            {
                await writer.CompleteAsync().ConfigureAwait(false);
            }
        }
    }
}
