// <copyright file="DebouncedFileWatcher.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.FileSystem.Watching;

/// <summary>
/// Implements <see cref="IFileWatcher"/> by wrapping <see cref="FileSystemWatcher"/>
/// and collapsing bursts within a configurable debounce window into a single event
/// per (path, kind) pair (INV-7).
/// </summary>
public sealed class DebouncedFileWatcher : IFileWatcher
{
    private readonly TimeSpan debounce;
    private readonly IClock clock;
    private readonly FileSystemWatcher watcher;
    private readonly Channel<FileEvent> channel;
    private readonly Dictionary<string, PendingEvent> pending = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly CancellationTokenSource cts = new();
    private readonly Task pump;

    /// <summary>Initializes a new instance of the <see cref="DebouncedFileWatcher"/> class.</summary>
    /// <param name="root">Absolute path to the directory to watch.</param>
    /// <param name="debounce">Time window during which bursts are collapsed.</param>
    /// <param name="clock">Clock used for timestamps and monotonic timing.</param>
    public DebouncedFileWatcher(AbsolutePath root, TimeSpan debounce, IClock clock)
    {
        if (debounce < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(debounce), "Debounce window must be non-negative.");
        }

        this.debounce = debounce;
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.channel = Channel.CreateUnbounded<FileEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        this.watcher = new FileSystemWatcher(root.Value)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName
                | NotifyFilters.LastWrite
                | NotifyFilters.Size
                | NotifyFilters.CreationTime
                | NotifyFilters.DirectoryName,
        };
        this.watcher.Created += (_, e) => this.Enqueue(e.FullPath, FileChangeKind.Created);
        this.watcher.Changed += (_, e) => this.Enqueue(e.FullPath, FileChangeKind.Modified);
        this.watcher.Deleted += (_, e) => this.Enqueue(e.FullPath, FileChangeKind.Deleted);
        this.watcher.Renamed += (_, e) => this.Enqueue(e.FullPath, FileChangeKind.Renamed);
        this.watcher.EnableRaisingEvents = true;

        this.pump = Task.Run(() => this.PumpAsync(this.cts.Token));
    }

    /// <inheritdoc/>
    public IAsyncEnumerable<FileEvent> Events => this.ReadAllAsync();

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        this.watcher.EnableRaisingEvents = false;
        this.watcher.Dispose();
        await this.cts.CancelAsync().ConfigureAwait(false);
        try
        {
            await this.pump.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // expected
        }

        // Flush any remaining pending events to the channel before completing.
        this.FlushPending(force: true);
        _ = this.channel.Writer.TryComplete();
        this.cts.Dispose();
    }

    private async IAsyncEnumerable<FileEvent> ReadAllAsync([EnumeratorCancellation] CancellationToken ct = default)
    {
        while (await this.channel.Reader.WaitToReadAsync(ct).ConfigureAwait(false))
        {
            while (this.channel.Reader.TryRead(out var ev))
            {
                yield return ev;
            }
        }
    }

    private void Enqueue(string path, FileChangeKind kind)
    {
        lock (this.gate)
        {
            this.pending[path + "\0" + (int)kind] = new PendingEvent(path, kind, this.clock.MonotonicMilliseconds);
        }
    }

    private async Task PumpAsync(CancellationToken ct)
    {
        var tickMs = Math.Max(10, (int)Math.Min(this.debounce.TotalMilliseconds / 2, int.MaxValue));
        if (tickMs <= 0)
        {
            tickMs = 10;
        }

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(tickMs, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            this.FlushPending(force: false);
        }
    }

    private void FlushPending(bool force)
    {
        var nowMs = this.clock.MonotonicMilliseconds;
        var dueKeys = new List<string>();

        lock (this.gate)
        {
            foreach (var kvp in this.pending)
            {
                var elapsed = nowMs - kvp.Value.LastSeenMs;
                if (force || elapsed >= (long)this.debounce.TotalMilliseconds)
                {
                    dueKeys.Add(kvp.Key);
                }
            }

            foreach (var key in dueKeys)
            {
                var ev = this.pending[key];
                _ = this.pending.Remove(key);
                var fe = new FileEvent(new AbsolutePath(ev.Path), ev.Kind, this.clock.UtcNow);
                _ = this.channel.Writer.TryWrite(fe);
            }
        }
    }

    private readonly record struct PendingEvent(string Path, FileChangeKind Kind, long LastSeenMs);
}
