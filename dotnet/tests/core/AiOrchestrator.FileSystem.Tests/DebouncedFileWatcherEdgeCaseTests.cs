// <copyright file="DebouncedFileWatcherEdgeCaseTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.FileSystem.Watching;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Edge case tests for <see cref="DebouncedFileWatcher"/>.</summary>
public sealed class DebouncedFileWatcherEdgeCaseTests
{
    [Fact]
    public void Ctor_NegativeDebounce_Throws()
    {
        using var temp = new TempDir();
        var clock = new TestClock();

        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new DebouncedFileWatcher(
                new AbsolutePath(temp.Path),
                TimeSpan.FromMilliseconds(-1),
                clock));
    }

    [Fact]
    public void Ctor_NullClock_Throws()
    {
        using var temp = new TempDir();

        Assert.Throws<ArgumentNullException>(() =>
            new DebouncedFileWatcher(
                new AbsolutePath(temp.Path),
                TimeSpan.FromMilliseconds(100),
                null!));
    }

    [Fact]
    public async Task DisposeAsync_SecondDispose_ThrowsObjectDisposed()
    {
        using var temp = new TempDir();
        var clock = new TestClock();

        var watcher = new DebouncedFileWatcher(
            new AbsolutePath(temp.Path),
            TimeSpan.FromMilliseconds(50),
            clock);

        await watcher.DisposeAsync();

        // The implementation disposes its CancellationTokenSource; second dispose throws.
        await Assert.ThrowsAsync<ObjectDisposedException>(() => watcher.DisposeAsync().AsTask());
    }

    [Fact]
    public async Task ZeroDebounce_EmitsEventsQuickly()
    {
        using var temp = new TempDir();
        var clock = new TestClock();

        await using var watcher = new DebouncedFileWatcher(
            new AbsolutePath(temp.Path),
            TimeSpan.Zero,
            clock);

        var target = Path.Combine(temp.Path, "zero-debounce.txt");
        await File.WriteAllTextAsync(target, "hello");

        // Wait briefly for the event to flush.
        await Task.Delay(300);

        var events = new List<FileEvent>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await foreach (var ev in watcher.Events.WithCancellation(cts.Token))
            {
                events.Add(ev);
                break;
            }
        }
        catch (OperationCanceledException) { }

        Assert.NotEmpty(events);
    }

    [Fact]
    public async Task DeletedFiles_ProduceDeletedEvents()
    {
        using var temp = new TempDir();
        var clock = new TestClock();

        await using var watcher = new DebouncedFileWatcher(
            new AbsolutePath(temp.Path),
            TimeSpan.FromMilliseconds(50),
            clock);

        var target = Path.Combine(temp.Path, "to-delete.txt");
        await File.WriteAllTextAsync(target, "temp");
        await Task.Delay(200);

        // Drain creation events first
        var drain = new List<FileEvent>();
        using var cts0 = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        try
        {
            await foreach (var ev in watcher.Events.WithCancellation(cts0.Token))
            {
                drain.Add(ev);
            }
        }
        catch (OperationCanceledException) { }

        // Now delete
        File.Delete(target);
        await Task.Delay(300);

        var events = new List<FileEvent>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await foreach (var ev in watcher.Events.WithCancellation(cts.Token))
            {
                events.Add(ev);
                if (ev.Kind == FileChangeKind.Deleted)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException) { }

        Assert.Contains(events, e => e.Kind == FileChangeKind.Deleted);
    }
}
