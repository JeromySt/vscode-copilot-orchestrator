// <copyright file="PidFileWriterTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Daemon.PidFile;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AiOrchestrator.Daemon.Tests;

public sealed class PidFileWriterTests
{
    [Fact]
    public async Task WriteAsync_AtomicViaTmpFile()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);
        var path = new AbsolutePath("/run/daemon.pid");

        await writer.WriteAsync(path, 9876, CancellationToken.None);

        Assert.True(fs.Files.ContainsKey(path.Value));
        var content = Encoding.UTF8.GetString(fs.Files[path.Value]).Trim();
        Assert.Equal("9876", content);
    }

    [Fact]
    public async Task IsRunningAsync_NoFile_ReturnsFalse()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);

        var result = await writer.IsRunningAsync(new AbsolutePath("/run/nope.pid"), CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async Task IsRunningAsync_InvalidPid_ReturnsFalse()
    {
        var fs = new InMemoryFileSystem();
        fs.Files["/run/bad.pid"] = Encoding.UTF8.GetBytes("not-a-number\n");
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);

        var result = await writer.IsRunningAsync(new AbsolutePath("/run/bad.pid"), CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async Task AcquireOrThrowAsync_WhenLiveProcess_Throws()
    {
        var fs = new InMemoryFileSystem();
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);
        var path = new AbsolutePath("/run/daemon.pid");

        // Write our own PID — it's definitely alive.
        await writer.WriteAsync(path, Environment.ProcessId, CancellationToken.None);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => writer.AcquireOrThrowAsync(path, CancellationToken.None).AsTask());
    }

    [Fact]
    public async Task AcquireOrThrowAsync_DeadPid_Succeeds()
    {
        var fs = new InMemoryFileSystem();
        fs.Files["/run/dead.pid"] = Encoding.UTF8.GetBytes("999999999\n");
        var clock = new FakeClock();
        var writer = new PidFileWriter(fs, clock, NullLogger<PidFileWriter>.Instance);
        var path = new AbsolutePath("/run/dead.pid");

        // A PID of 999999999 should not be running.
        await writer.AcquireOrThrowAsync(path, CancellationToken.None);

        var content = Encoding.UTF8.GetString(fs.Files[path.Value]).Trim();
        Assert.Equal(Environment.ProcessId.ToString(), content);
    }
}
