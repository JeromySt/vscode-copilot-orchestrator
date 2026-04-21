// <copyright file="AgentRunnerBase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Agent.Handlers;
using AiOrchestrator.Models;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Agent.Runners;

/// <summary>Shared pipeline for all concrete agent runners.</summary>
internal abstract class AgentRunnerBase : IAgentRunner
{
    /// <summary>Exit code surrogate when the runner kills the agent for exceeding <see cref="AgentSpec.MaxTurns"/> (INV-9).</summary>
    internal const int AgentMaxTurnsExceeded = -997;

    private static readonly TimeSpan KillGracePeriod = TimeSpan.FromSeconds(10);

    private static readonly Action<ILogger, AgentRunnerKind, Exception?> LogSandboxUnsupported =
        LoggerMessage.Define<AgentRunnerKind>(
            LogLevel.Warning,
            new EventId(1, nameof(LogSandboxUnsupported)),
            "Runner {Kind} does not support allowed-folder sandboxing; emitting AgentSandboxUnsupported warning.");

    private static readonly Action<ILogger, AgentRunnerKind, int, Exception?> LogDoneMissing =
        LoggerMessage.Define<AgentRunnerKind, int>(
            LogLevel.Warning,
            new EventId(2, nameof(LogDoneMissing)),
            "Agent {Kind} exited without emitting task-complete marker (exit {Code}).");

    private readonly IProcessSpawner spawner;
    private readonly IClock clock;
    private readonly IExecutableLocator locator;
    private readonly ILogger logger;

    /// <summary>Initializes a new instance of the <see cref="AgentRunnerBase"/> class.</summary>
    /// <param name="spawner">Process spawner (INV-1).</param>
    /// <param name="clock">Clock.</param>
    /// <param name="locator">Executable locator (INV-12).</param>
    /// <param name="logger">Logger.</param>
    protected AgentRunnerBase(IProcessSpawner spawner, IClock clock, IExecutableLocator locator, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(locator);
        ArgumentNullException.ThrowIfNull(logger);

        this.spawner = spawner;
        this.clock = clock;
        this.locator = locator;
        this.logger = logger;
    }

    /// <inheritdoc/>
    public abstract AgentRunnerKind Kind { get; }

    /// <summary>Gets the basename of the executable probed on PATH.</summary>
    protected abstract string ExecutableName { get; }

    /// <summary>Gets a value indicating whether this runner supports sandboxing via allowed-folders (INV-10).</summary>
    protected virtual bool SupportsSandbox => true;

    /// <summary>Gets a value indicating whether this runner supports the <see cref="Effort.Xhigh"/> knob (INV-8).</summary>
    protected virtual bool SupportsXhighEffort => false;

    /// <inheritdoc/>
    public async ValueTask<AgentRunResult> RunAsync(AgentSpec spec, RunContext ctx, IAgentEventSink sink, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(sink);

        if (spec.Effort == Effort.Xhigh && !this.SupportsXhighEffort)
        {
            throw new ArgumentException(
                $"Runner '{this.Kind}' does not support Effort.Xhigh.",
                nameof(spec));
        }

        var absolute = this.locator.Locate(this.ExecutableName)
            ?? throw new AgentRunnerNotInstalledException(this.Kind, this.ExecutableName);

        var args = this.BuildArgs(spec);
        var processSpec = new ProcessSpec
        {
            Producer = $"agent-{this.Kind}",
            Description = $"agent:{this.Kind}",
            Executable = absolute,
            Arguments = args,
            Environment = spec.Env,
        };

        var sessionHandler = new SessionIdHandler(this.clock);
        var statsHandler = new StatsHandler(this.clock);
        var doneHandler = new TaskCompleteHandler(this.clock);
        var pressureHandler = new ContextPressureHandler(this.clock);

        var startMs = this.clock.MonotonicMilliseconds;

        var sandboxUnsupported = !this.SupportsSandbox && !spec.AllowedFolders.IsDefaultOrEmpty;
        if (sandboxUnsupported)
        {
            LogSandboxUnsupported(this.logger, this.Kind, null);
        }

        await using var handle = await this.spawner.SpawnAsync(processSpec, ct).ConfigureAwait(false);

        using var turnCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var maxTurnsExceeded = false;

        void OnMaxTurnsExceeded()
        {
            maxTurnsExceeded = true;
            turnCts.Cancel();
        }

        var state = new PumpState(
            spec,
            sink,
            sessionHandler,
            statsHandler,
            doneHandler,
            pressureHandler,
            OnMaxTurnsExceeded);

        var stdoutTask = this.PumpAsync(handle.StandardOut, AgentStream.Stdout, state, turnCts.Token);
        var stderrTask = this.PumpAsync(handle.StandardError, AgentStream.Stderr, state, turnCts.Token);

        var exitTask = handle.WaitForExitAsync(CancellationToken.None);

        int exitCode;
        try
        {
            var winner = await Task.WhenAny(exitTask, Task.Delay(Timeout.InfiniteTimeSpan, turnCts.Token))
                .ConfigureAwait(false);
            if (winner != exitTask)
            {
                await this.EscalateTerminationAsync(handle, exitTask).ConfigureAwait(false);
            }

            exitCode = await exitTask.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await this.EscalateTerminationAsync(handle, exitTask).ConfigureAwait(false);
            exitCode = await exitTask.ConfigureAwait(false);
        }

        try
        {
            await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        var duration = TimeSpan.FromMilliseconds(Math.Max(0, this.clock.MonotonicMilliseconds - startMs));

        if (!doneHandler.Completed)
        {
            LogDoneMissing(this.logger, this.Kind, exitCode, null);
        }

        if (maxTurnsExceeded && exitCode == 0)
        {
            exitCode = AgentMaxTurnsExceeded;
        }

        return new AgentRunResult
        {
            ExitCode = exitCode,
            SessionId = sessionHandler.SessionId,
            Stats = statsHandler.Current,
            Duration = duration,
            TaskCompleteEmitted = doneHandler.Completed,
            ChangedFiles = ImmutableArray<RepoRelativePath>.Empty,
            MaxTurnsExceeded = maxTurnsExceeded,
            SandboxUnsupportedWarning = sandboxUnsupported,
        };
    }

    /// <summary>Builds the command-line argv for the runner.</summary>
    /// <param name="spec">The spec.</param>
    /// <returns>Immutable argv.</returns>
    protected abstract ImmutableArray<string> BuildArgs(AgentSpec spec);

    private async Task EscalateTerminationAsync(IProcessHandle handle, Task<int> exitTask)
    {
        try
        {
            await handle.SignalAsync(ProcessSignal.Terminate, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException)
        {
        }

        var graceDone = await Task.WhenAny(exitTask, Task.Delay(KillGracePeriod, CancellationToken.None))
            .ConfigureAwait(false);
        if (graceDone != exitTask)
        {
            try
            {
                await handle.SignalAsync(ProcessSignal.Kill, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException)
            {
            }
        }
    }

    private async Task PumpAsync(PipeReader reader, AgentStream stream, PumpState state, CancellationToken ct)
    {
        var lineBuilder = new StringBuilder();
        try
        {
            while (true)
            {
                ReadResult read;
                try
                {
                    read = await reader.ReadAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (IOException)
                {
                    break;
                }

                var buffer = read.Buffer;
                await this.ProcessBufferAsync(buffer, stream, state, lineBuilder, ct).ConfigureAwait(false);
                reader.AdvanceTo(buffer.End);
                if (read.IsCompleted)
                {
                    break;
                }
            }

            if (lineBuilder.Length > 0)
            {
                var final = new LineEmitted
                {
                    Stream = stream,
                    Line = lineBuilder.ToString(),
                    MonotonicMs = this.clock.MonotonicMilliseconds,
                };
                await this.DispatchLineAsync(final, state, CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            await reader.CompleteAsync().ConfigureAwait(false);
        }
    }

    private async Task ProcessBufferAsync(ReadOnlySequence<byte> buffer, AgentStream stream, PumpState state, StringBuilder lineBuilder, CancellationToken ct)
    {
        var text = Encoding.UTF8.GetString(buffer);
        foreach (var ch in text)
        {
            if (ch == '\n')
            {
                var raw = lineBuilder.ToString();
                _ = lineBuilder.Clear();
                if (raw.Length > 0 && raw[^1] == '\r')
                {
                    raw = raw[..^1];
                }

                var line = new LineEmitted
                {
                    Stream = stream,
                    Line = raw,
                    MonotonicMs = this.clock.MonotonicMilliseconds,
                };

                await this.DispatchLineAsync(line, state, ct).ConfigureAwait(false);

                if (state.SessionHandler.SessionId is { } sid && state.TryForwardSession(sid))
                {
                    await state.Sink.OnSessionIdAsync(sid, ct).ConfigureAwait(false);
                }

                await state.Sink.OnStatsAsync(state.StatsHandler.Current, ct).ConfigureAwait(false);

                if (state.PressureHandler.PendingTransition)
                {
                    await state.Sink.OnContextPressureAsync(
                        state.PressureHandler.Level,
                        state.PressureHandler.Fraction,
                        ct).ConfigureAwait(false);
                    state.PressureHandler.ClearPending();
                }

                if (state.DoneHandler.Completed && state.TryForwardDone())
                {
                    await state.Sink.OnTaskCompleteAsync(state.DoneHandler.FinalResponse, ct).ConfigureAwait(false);
                }

                if (state.StatsHandler.Current.Turns > state.Spec.MaxTurns)
                {
                    state.OnMaxTurns();
                }
            }
            else
            {
                _ = lineBuilder.Append(ch);
            }
        }
    }

    private async Task DispatchLineAsync(LineEmitted line, PumpState state, CancellationToken ct)
    {
        await state.Sink.OnRawLineAsync(line, ct).ConfigureAwait(false);
        _ = state.SessionHandler.TryHandle(line, state.Spec);
        _ = state.StatsHandler.TryHandle(line, state.Spec);
        _ = state.DoneHandler.TryHandle(line, state.Spec);
        _ = state.PressureHandler.TryHandle(line, state.Spec);
    }

    private sealed class PumpState
    {
        private string? lastSessionId;
        private bool doneForwarded;

        public PumpState(
            AgentSpec spec,
            IAgentEventSink sink,
            SessionIdHandler sessionHandler,
            StatsHandler statsHandler,
            TaskCompleteHandler doneHandler,
            ContextPressureHandler pressureHandler,
            Action onMaxTurns)
        {
            this.Spec = spec;
            this.Sink = sink;
            this.SessionHandler = sessionHandler;
            this.StatsHandler = statsHandler;
            this.DoneHandler = doneHandler;
            this.PressureHandler = pressureHandler;
            this.OnMaxTurns = onMaxTurns;
        }

        public AgentSpec Spec { get; }

        public IAgentEventSink Sink { get; }

        public SessionIdHandler SessionHandler { get; }

        public StatsHandler StatsHandler { get; }

        public TaskCompleteHandler DoneHandler { get; }

        public ContextPressureHandler PressureHandler { get; }

        public Action OnMaxTurns { get; }

        public bool TryForwardSession(string id)
        {
            if (this.lastSessionId == id)
            {
                return false;
            }

            this.lastSessionId = id;
            return true;
        }

        public bool TryForwardDone()
        {
            if (this.doneForwarded)
            {
                return false;
            }

            this.doneForwarded = true;
            return true;
        }
    }
}
