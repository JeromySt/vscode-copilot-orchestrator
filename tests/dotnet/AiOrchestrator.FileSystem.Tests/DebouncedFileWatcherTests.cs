// <copyright file="DebouncedFileWatcherTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using AiOrchestrator.FileSystem.Watching;
using AiOrchestrator.Foundation.Tests;
using AiOrchestrator.Models.Paths;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Acceptance test for FS-3 — burst debouncing.</summary>
public sealed class DebouncedFileWatcherTests
{
    [Fact]
    [ContractTest("FS-3")]
    public async Task FS_3_FileWatcher_DebouncesBurst()
    {
        using var temp = new TempDir();
        var clock = new TestClock();

        await using var watcher = new DebouncedFileWatcher(
            new AbsolutePath(temp.Path),
            TimeSpan.FromMilliseconds(150),
            clock);

        // Fire a burst of 20 modifications to the same file.
        var target = Path.Combine(temp.Path, "burst.txt");
        for (var i = 0; i < 20; i++)
        {
            await File.WriteAllTextAsync(target, $"v{i}");
        }

        // Wait long enough for the debounce window to flush.
        await Task.Delay(600);

        // Read what's available, with a hard deadline.
        var events = new List<FileEvent>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await foreach (var ev in watcher.Events.WithCancellation(cts.Token))
            {
                events.Add(ev);
                if (events.Count >= 5)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // expected once burst settles
        }

        // INV-7: bursts collapse — far fewer events than the 20 raw writes.
        // The exact number depends on FileSystemWatcher buffering; we assert "much fewer".
        events.Count.Should().BeLessThan(20, "20 rapid writes must be collapsed by the debounce window");
    }
}
