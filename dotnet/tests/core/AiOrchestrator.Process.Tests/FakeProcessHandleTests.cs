// <copyright file="FakeProcessHandleTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Tests for <see cref="FakeProcessHandle"/> to increase coverage on test doubles.</summary>
public sealed class FakeProcessHandleTests
{
    [Fact]
    public async Task WaitForExit_ReturnsExitCodeAfterComplete()
    {
        var handle = new FakeProcessHandle(42);
        handle.Complete(7);

        var exitCode = await handle.WaitForExitAsync(CancellationToken.None);

        Assert.Equal(7, exitCode);
    }

    [Fact]
    public async Task WriteStdout_IsReadable()
    {
        var handle = new FakeProcessHandle(1);
        var data = Encoding.UTF8.GetBytes("hello world");

        await handle.WriteStdoutAsync(data);
        handle.Complete(0);

        var result = await handle.StandardOut.ReadAsync();
        var text = Encoding.UTF8.GetString(result.Buffer.FirstSpan);

        Assert.Contains("hello world", text);
    }

    [Fact]
    public async Task WriteStderr_IsReadable()
    {
        var handle = new FakeProcessHandle(1);
        var data = Encoding.UTF8.GetBytes("error output");

        await handle.WriteStderrAsync(data);
        handle.Complete(0);

        var result = await handle.StandardError.ReadAsync();
        var text = Encoding.UTF8.GetString(result.Buffer.FirstSpan);

        Assert.Contains("error output", text);
    }

    [Fact]
    public void ProcessId_ReturnsAssignedValue()
    {
        var handle = new FakeProcessHandle(999);

        Assert.Equal(999, handle.ProcessId);
    }

    [Fact]
    public void StandardIn_IsNotNull()
    {
        var handle = new FakeProcessHandle(1);

        Assert.NotNull(handle.StandardIn);
    }

    [Fact]
    public async Task SignalAsync_RecordsSignals()
    {
        var handle = new FakeProcessHandle(1);

        await handle.SignalAsync(Abstractions.Process.ProcessSignal.Terminate, CancellationToken.None);
        await handle.SignalAsync(Abstractions.Process.ProcessSignal.Kill, CancellationToken.None);

        Assert.Equal(2, handle.SignalsSent.Count);
        Assert.Equal(Abstractions.Process.ProcessSignal.Terminate, handle.SignalsSent[0]);
        Assert.Equal(Abstractions.Process.ProcessSignal.Kill, handle.SignalsSent[1]);
    }

    [Fact]
    public async Task DisposeAsync_IsIdempotent()
    {
        var handle = new FakeProcessHandle(1);
        handle.Complete(0);

        await handle.DisposeAsync();
        await handle.DisposeAsync();
        await handle.DisposeAsync();

        // No exception = pass
    }
}
