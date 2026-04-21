// <copyright file="LineProjectorTests.cs" company="AiOrchestrator">
// Copyright (c) AiOrchestrator. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO.Pipelines;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.LineView;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.LineView.Tests;

/// <summary>Marks a test as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

/// <summary>Captures emitted lines for assertion.</summary>
internal sealed class CapturingSink : ILineSink
{
    public List<string> Lines { get; } = new();

    public void OnLine(ReadOnlySpan<byte> line)
    {
        this.Lines.Add(Encoding.UTF8.GetString(line));
    }
}

/// <summary>Acceptance tests for <see cref="LineProjector"/>.</summary>
public sealed class LineProjectorTests
{
    [Fact]
    [ContractTest("LV-1")]
    public void LV1_SingleLineWithLfTerminator_EmitsOneLine()
    {
        var projector = new LineProjector();
        var sink = new CapturingSink();
        var result = projector.Project(Encoding.UTF8.GetBytes("hello\n"), sink);

        result.LinesEmitted.Should().Be(1);
        sink.Lines.Should().ContainSingle().Which.Should().Be("hello");
    }

    [Fact]
    [ContractTest("LV-2")]
    public void LV2_CrlfLineEnding_EmitsLineWithoutCr()
    {
        var projector = new LineProjector();
        var sink = new CapturingSink();
        projector.Project(Encoding.UTF8.GetBytes("hello\r\nworld\r\n"), sink);

        sink.Lines.Should().Equal("hello", "world");
    }

    [Fact]
    [ContractTest("LV-3")]
    public void LV3_LineSplitAcrossChunks_EmitsAfterTerminatorArrives()
    {
        var projector = new LineProjector();
        var sink = new CapturingSink();
        projector.Project(Encoding.UTF8.GetBytes("hel"), sink);
        projector.Project(Encoding.UTF8.GetBytes("lo\n"), sink);

        sink.Lines.Should().ContainSingle().Which.Should().Be("hello");
    }

    [Fact]
    [ContractTest("LV-4")]
    public void LV4_PartialUtf8SequenceAcrossChunks_DoesNotProduceMojibake()
    {
        // "café\n" — é is C3 A9 in UTF-8; split between bytes.
        var bytes = Encoding.UTF8.GetBytes("café\n");
        int splitAt = Array.IndexOf(bytes, (byte)0xC3) + 1;

        var projector = new LineProjector();
        var sink = new CapturingSink();
        projector.Project(bytes.AsSpan(0, splitAt), sink);
        projector.Project(bytes.AsSpan(splitAt), sink);

        sink.Lines.Should().ContainSingle().Which.Should().Be("café");
    }

    [Fact]
    [ContractTest("LV-5")]
    public void LV5_AnsiEscapeStripped_WhenStripAnsiTrue()
    {
        var projector = new LineProjector(new LineProjectionOptions { StripAnsi = true });
        var sink = new CapturingSink();
        projector.Project(Encoding.UTF8.GetBytes("\u001b[31mred\u001b[0m\n"), sink);

        sink.Lines.Should().ContainSingle().Which.Should().Be("red");
    }

    [Fact]
    [ContractTest("LV-6")]
    public void LV6_FlushEmitsTrailingPartialLine()
    {
        var projector = new LineProjector();
        var sink = new CapturingSink();
        projector.Project(Encoding.UTF8.GetBytes("partial"), sink);
        var flushResult = projector.Flush(sink);

        sink.Lines.Should().ContainSingle().Which.Should().Be("partial");
        flushResult.LinesEmitted.Should().Be(1);
    }

    [Fact]
    [ContractTest("LV-ASYNC-1")]
    public async Task LVAsync1_ProjectAsync_EmitsLinesFromPipeReader()
    {
        var pipe = new Pipe();
        await pipe.Writer.WriteAsync(Encoding.UTF8.GetBytes("a\nb\n"));
        await pipe.Writer.CompleteAsync();

        var projector = new LineProjector();
        var sink = new CapturingSink();
        await projector.ProjectAsync(pipe.Reader, sink, CancellationToken.None);

        sink.Lines.Should().Equal("a", "b");
    }

    [Fact]
    [ContractTest("LV-ASYNC-2")]
    public async Task LVAsync2_ProjectAsync_RespectsCancellation()
    {
        var pipe = new Pipe();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var projector = new LineProjector();
        var sink = new CapturingSink();

        Func<Task> act = async () => await projector.ProjectAsync(pipe.Reader, sink, cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
