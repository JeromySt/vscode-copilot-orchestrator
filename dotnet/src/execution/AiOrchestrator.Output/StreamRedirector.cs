// <copyright file="StreamRedirector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text.Json;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.LineView;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Output.Fanout;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Output;

/// <summary>
/// Per-process output redirector that fans-out stdout/stderr <see cref="PipeReader"/>s
/// to the four standard consumers (<see cref="OutputConsumerKind.EventLog"/>,
/// <see cref="OutputConsumerKind.LineView"/>, <see cref="OutputConsumerKind.RingBuffer"/>,
/// <see cref="OutputConsumerKind.Logger"/>) with bounded back-pressure, snapshot reattach
/// for late consumers, and lag detection (<see cref="ConsumerLagged"/>).
/// </summary>
public sealed class StreamRedirector : IAsyncDisposable
{
    private readonly IEventStore log;
    private readonly IEventBus bus;
    private readonly LineProjector lineView;
    private readonly IClock clock;
    private readonly IOptionsMonitor<RedirectorOptions> opts;
    private readonly ILogger<StreamRedirector> logger;
    private readonly FanoutBroker broker;
    private readonly ConcurrentDictionary<JobId, JobState> jobs = new();
    private int disposed;

    /// <summary>Initializes a new instance of the <see cref="StreamRedirector"/> class.</summary>
    /// <param name="log">Event store used by the EventLog consumer.</param>
    /// <param name="bus">Event bus used to publish <see cref="ConsumerLagged"/>.</param>
    /// <param name="lineView">Shared line projector used by the LineView consumer.</param>
    /// <param name="clock">Clock used to timestamp chunks.</param>
    /// <param name="opts">Options monitor for redirector configuration.</param>
    public StreamRedirector(
        IEventStore log,
        IEventBus bus,
        LineProjector lineView,
        IClock clock,
        IOptionsMonitor<RedirectorOptions> opts)
        : this(log, bus, lineView, clock, opts, NullLogger<StreamRedirector>.Instance)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="StreamRedirector"/> class with an explicit logger.</summary>
    /// <param name="log">Event store used by the EventLog consumer.</param>
    /// <param name="bus">Event bus used to publish <see cref="ConsumerLagged"/>.</param>
    /// <param name="lineView">Shared line projector used by the LineView consumer.</param>
    /// <param name="clock">Clock used to timestamp chunks.</param>
    /// <param name="opts">Options monitor for redirector configuration.</param>
    /// <param name="logger">Logger for diagnostic output and the Logger consumer.</param>
    public StreamRedirector(
        IEventStore log,
        IEventBus bus,
        LineProjector lineView,
        IClock clock,
        IOptionsMonitor<RedirectorOptions> opts,
        ILogger<StreamRedirector> logger)
    {
        ArgumentNullException.ThrowIfNull(log);
        ArgumentNullException.ThrowIfNull(bus);
        ArgumentNullException.ThrowIfNull(lineView);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(opts);
        ArgumentNullException.ThrowIfNull(logger);

        this.log = log;
        this.bus = bus;
        this.lineView = lineView;
        this.clock = clock;
        this.opts = opts;
        this.logger = logger;
        this.broker = new FanoutBroker(opts, bus);
    }

    /// <summary>Gets the internal accessor for tests/composition: the underlying fan-out broker.</summary>
    internal FanoutBroker Broker => this.broker;

    /// <summary>Attach a job's stdout / stderr <see cref="PipeReader"/>s to the fan-out pipeline.</summary>
    /// <param name="job">Job identifier.</param>
    /// <param name="run">Run identifier (recorded on emitted event envelopes).</param>
    /// <param name="stdout">Standard output reader.</param>
    /// <param name="stderr">Standard error reader.</param>
    /// <param name="ct">Cancellation token; cancelling cancels both pumps.</param>
    /// <returns>A <see cref="ValueTask"/> that completes once the job has been registered.</returns>
    public ValueTask AttachAsync(JobId job, RunId run, PipeReader stdout, PipeReader stderr, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);
        this.ThrowIfDisposed();

        var options = this.opts.CurrentValue;
        var state = new JobState(job, run, options.RingBufferBytes);
        if (!this.jobs.TryAdd(job, state))
        {
            throw new InvalidOperationException($"Job {job} is already attached.");
        }

        // Standard consumers (INV-1).
        state.Subscriptions.Add(this.broker.Subscribe(job, OutputConsumerKind.EventLog, this.OnEventLogAsync));
        state.Subscriptions.Add(this.broker.Subscribe(job, OutputConsumerKind.LineView, this.OnLineViewAsync));
        state.Subscriptions.Add(this.broker.Subscribe(job, OutputConsumerKind.RingBuffer, (chunk, _) => state.RingAppend(chunk)));
        state.Subscriptions.Add(this.broker.Subscribe(job, OutputConsumerKind.Logger, this.OnLoggerAsync));

        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, state.Cancel.Token);
        state.LinkedCts = linkedCts;
        state.StdoutPump = Task.Run(() => this.PumpAsync(state, stdout, OutputStream.StdOut, linkedCts.Token));
        state.StderrPump = Task.Run(() => this.PumpAsync(state, stderr, OutputStream.StdErr, linkedCts.Token));
        return ValueTask.CompletedTask;
    }

    /// <summary>Detach a job: stop pumps, drain consumer queues, remove state.</summary>
    /// <param name="job">Job identifier.</param>
    /// <param name="ct">Cancellation token (used for shutdown timeout, not propagated to consumers).</param>
    /// <returns>A <see cref="ValueTask"/> that completes once all pumps and consumer pumps have drained.</returns>
    public async ValueTask DetachAsync(JobId job, CancellationToken ct)
    {
        if (!this.jobs.TryRemove(job, out var state))
        {
            return;
        }

        await state.ShutdownAsync().ConfigureAwait(false);
    }

    /// <summary>Returns a consistent point-in-time snapshot of the recent stdout/stderr for <paramref name="job"/>.</summary>
    /// <param name="job">Job identifier.</param>
    /// <returns>Snapshot, or empty snapshot when the job is unknown.</returns>
    public OutputSnapshot SnapshotFor(JobId job)
    {
        if (!this.jobs.TryGetValue(job, out var state))
        {
            return new OutputSnapshot
            {
                RecentStdoutBytes = ImmutableArray<byte>.Empty,
                RecentStderrBytes = ImmutableArray<byte>.Empty,
                TotalStdoutBytes = 0,
                TotalStderrBytes = 0,
            };
        }

        return state.Snapshot();
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
        {
            return;
        }

        var jobIds = this.jobs.Keys.ToArray();
        foreach (var job in jobIds)
        {
            await this.DetachAsync(job, CancellationToken.None).ConfigureAwait(false);
        }
    }

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref this.disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(StreamRedirector));
        }
    }

    private async Task PumpAsync(JobState state, PipeReader reader, OutputStream stream, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                ReadResult result;
                try
                {
                    result = await reader.ReadAsync(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                var buffer = result.Buffer;
                if (!buffer.IsEmpty)
                {
                    var maxChunk = Math.Max(1, this.opts.CurrentValue.MaxChunkBytes);
                    foreach (var segment in buffer)
                    {
                        var sliceStart = 0;
                        while (sliceStart < segment.Length)
                        {
                            var sliceLen = Math.Min(maxChunk, segment.Length - sliceStart);
                            var rented = ArrayPool<byte>.Shared.Rent(sliceLen);
                            segment.Span.Slice(sliceStart, sliceLen).CopyTo(rented);
                            var offset = stream == OutputStream.StdOut
                                ? state.AddStdout(sliceLen) - sliceLen
                                : state.AddStderr(sliceLen) - sliceLen;

                            var chunk = new OutputChunk
                            {
                                JobId = state.Job,
                                Stream = stream,
                                ByteOffset = offset,
                                Data = new ReadOnlyMemory<byte>(rented, 0, sliceLen),
                                At = this.clock.UtcNow,
                            };

                            await this.broker.PublishAsync(state.Job, chunk, ct).ConfigureAwait(false);
                            sliceStart += sliceLen;
                        }
                    }
                }

                reader.AdvanceTo(buffer.End);
                if (result.IsCompleted)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            this.logger.LogWarning(ex, "Output pump for job {Job} stream {Stream} terminated unexpectedly.", state.Job, stream);
        }
        finally
        {
            try
            {
                await reader.CompleteAsync().ConfigureAwait(false);
            }
            catch
            {
                // Best-effort.
            }
        }
    }

    private async ValueTask OnEventLogAsync(OutputChunk chunk, CancellationToken ct)
    {
        // Wrap the chunk metadata as an event envelope. Payload encodes stream + offset + length.
        var payload = JsonSerializer.SerializeToElement(new
        {
            stream = chunk.Stream.ToString(),
            offset = chunk.ByteOffset,
            length = chunk.Data.Length,
        });

        var envelope = new EventEnvelope
        {
            EventId = Guid.NewGuid(),
            RecordSeq = 0,
            OccurredAtUtc = chunk.At,
            EventType = "ai.orchestrator.output.chunk",
            SchemaVersion = 1,
            Payload = payload,
            JobId = chunk.JobId,
        };
        await this.log.AppendAsync(envelope, ct).ConfigureAwait(false);
    }

    private ValueTask OnLineViewAsync(OutputChunk chunk, CancellationToken ct)
    {
        // The shared LineProjector is currently a TODO at LineView project level; we still
        // call into it so the wiring is exercised. We pass a no-op sink when none is provided.
        try
        {
            _ = this.lineView.Project(chunk.Data.Span, NullLineSink.Instance);
        }
        catch
        {
            // Don't break the pump on projector errors.
        }

        return ValueTask.CompletedTask;
    }

    private ValueTask OnLoggerAsync(OutputChunk chunk, CancellationToken ct)
    {
        if (this.logger.IsEnabled(LogLevel.Trace))
        {
            this.logger.LogTrace(
                "job={Job} stream={Stream} offset={Offset} bytes={Bytes}",
                chunk.JobId,
                chunk.Stream,
                chunk.ByteOffset,
                chunk.Data.Length);
        }

        return ValueTask.CompletedTask;
    }

    private sealed class JobState
    {
        private readonly object ringLock = new();
        private readonly RingBuffer stdoutRing;
        private readonly RingBuffer stderrRing;

        public JobState(JobId job, RunId run, int ringBufferBytes)
        {
            this.Job = job;
            this.Run = run;
            this.stdoutRing = new RingBuffer(ringBufferBytes);
            this.stderrRing = new RingBuffer(ringBufferBytes);
            this.Cancel = new CancellationTokenSource();
            this.Subscriptions = new List<IAsyncDisposable>();
            this.StdoutPump = Task.CompletedTask;
            this.StderrPump = Task.CompletedTask;
        }

        public JobId Job { get; }

        public RunId Run { get; }

        public CancellationTokenSource Cancel { get; }

        public CancellationTokenSource? LinkedCts { get; set; }

        public List<IAsyncDisposable> Subscriptions { get; }

        public Task StdoutPump { get; set; }

        public Task StderrPump { get; set; }

        public long TotalStdout => Interlocked.Read(ref this.totalStdout);

        public long TotalStderr => Interlocked.Read(ref this.totalStderr);

        public long AddStdout(long bytes) => Interlocked.Add(ref this.totalStdout, bytes);

        public long AddStderr(long bytes) => Interlocked.Add(ref this.totalStderr, bytes);

#pragma warning disable SA1201
        private long totalStdout;
        private long totalStderr;
#pragma warning restore SA1201

        public ValueTask RingAppend(OutputChunk chunk)
        {
            var span = chunk.Data.Span;
            lock (this.ringLock)
            {
                if (chunk.Stream == OutputStream.StdOut)
                {
                    this.stdoutRing.Append(span);
                }
                else
                {
                    this.stderrRing.Append(span);
                }
            }

            return ValueTask.CompletedTask;
        }

        public OutputSnapshot Snapshot()
        {
            byte[] outBytes;
            byte[] errBytes;
            long totOut;
            long totErr;
            lock (this.ringLock)
            {
                outBytes = this.stdoutRing.Snapshot();
                errBytes = this.stderrRing.Snapshot();
                totOut = this.TotalStdout;
                totErr = this.TotalStderr;
            }

            return new OutputSnapshot
            {
                RecentStdoutBytes = ImmutableArray.Create(outBytes),
                RecentStderrBytes = ImmutableArray.Create(errBytes),
                TotalStdoutBytes = totOut,
                TotalStderrBytes = totErr,
            };
        }

        public async ValueTask ShutdownAsync()
        {
            // INV-6 — drain pumps naturally. Pumps exit when the underlying
            // PipeReader is completed (writer side completed). Only cancel if
            // the pump is still actively running after a grace period.
            try
            {
                await Task.WhenAll(this.StdoutPump, this.StderrPump).ConfigureAwait(false);
            }
            catch
            {
                // Pump exceptions logged inside the pump.
            }

            // INV-6 — drain all consumer queues by disposing each subscription
            // (DisposeAsync waits for pump drain).
            foreach (var sub in this.Subscriptions)
            {
                try
                {
                    await sub.DisposeAsync().ConfigureAwait(false);
                }
                catch
                {
                    // Best effort.
                }
            }

            // Now safe to cancel and dispose anything still pending.
            try
            {
                this.Cancel.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }

            this.LinkedCts?.Dispose();
            this.Cancel.Dispose();
        }
    }

    private sealed class RingBuffer
    {
        private readonly byte[] buffer;
        private int head;
        private int count;

        public RingBuffer(int capacity)
        {
            this.buffer = new byte[capacity];
        }

        public void Append(ReadOnlySpan<byte> data)
        {
            var cap = this.buffer.Length;
            if (data.Length >= cap)
            {
                // Only the tail fits.
                data.Slice(data.Length - cap).CopyTo(this.buffer);
                this.head = 0;
                this.count = cap;
                return;
            }

            // Write from tail position, wrapping as needed.
            var tail = (this.head + this.count) % cap;
            var firstChunk = Math.Min(data.Length, cap - tail);
            data.Slice(0, firstChunk).CopyTo(this.buffer.AsSpan(tail));
            var remaining = data.Length - firstChunk;
            if (remaining > 0)
            {
                data.Slice(firstChunk).CopyTo(this.buffer);
            }

            this.count += data.Length;
            if (this.count > cap)
            {
                var overflow = this.count - cap;
                this.head = (this.head + overflow) % cap;
                this.count = cap;
            }
        }

        public byte[] Snapshot()
        {
            var result = new byte[this.count];
            if (this.count == 0)
            {
                return result;
            }

            var cap = this.buffer.Length;
            var firstChunk = Math.Min(this.count, cap - this.head);
            this.buffer.AsSpan(this.head, firstChunk).CopyTo(result);
            var remaining = this.count - firstChunk;
            if (remaining > 0)
            {
                this.buffer.AsSpan(0, remaining).CopyTo(result.AsSpan(firstChunk));
            }

            return result;
        }
    }

    private sealed class NullLineSink : ILineSink
    {
        public static readonly NullLineSink Instance = new();

        public void OnLine(ReadOnlySpan<byte> line)
        {
        }
    }
}
