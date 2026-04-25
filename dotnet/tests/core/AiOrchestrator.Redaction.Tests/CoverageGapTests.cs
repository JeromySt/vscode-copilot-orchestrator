// <copyright file="CoverageGapTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Redaction;
using AiOrchestrator.Redaction.Detectors;
using AiOrchestrator.Redaction.Pseudonymization;
using Xunit;

namespace AiOrchestrator.Redaction.Tests;

/// <summary>Tests covering uncovered branches in Redaction assembly.</summary>
public sealed class CoverageGapTests
{
    // =====================================================================
    // Pseudonymizer
    // =====================================================================

    [Fact]
    public void Pseudonymizer_OffMode_ReturnsRedactedMarker()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Off);
        var result = ps.Pseudonymize(@"C:\Users\john\Documents", new byte[] { 1, 2, 3 });
        Assert.Equal("[REDACTED]", result);
    }

    [Fact]
    public void Pseudonymizer_AnonymousMode_ReturnsDeterministicPseudonym()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Anonymous);
        var salt = Encoding.UTF8.GetBytes("test-salt");
        var path = @"C:\Users\alice\Documents\report.pdf";

        var first = ps.Pseudonymize(path, salt);
        var second = ps.Pseudonymize(path, salt);
        Assert.Equal(first, second);
        Assert.StartsWith("[ANON:", first);
        Assert.EndsWith("]", first);
    }

    [Fact]
    public void Pseudonymizer_AnonymousMode_DifferentSaltsProduceDifferentOutput()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Anonymous);
        var path = @"C:\Users\alice\Documents";
        var a = ps.Pseudonymize(path, new byte[] { 1, 2, 3 });
        var b = ps.Pseudonymize(path, new byte[] { 4, 5, 6 });
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void Pseudonymizer_AnonymousMode_OutputNeverExceedsInputLength()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Anonymous);
        var salt = new byte[16];
        var path = @"C:\Users\alice\Documents\report.pdf";
        var result = ps.Pseudonymize(path, salt);
        Assert.True(result.Length <= path.Length);
    }

    [Fact]
    public void Pseudonymizer_AnonymousMode_ShortPathFallsBackToStars()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Anonymous);
        var salt = new byte[16];
        // "[ANON:XXXXXXXX]" is 15 chars — if path < 15 chars, should use stars
        var path = "short";
        var result = ps.Pseudonymize(path, salt);
        Assert.Equal(path.Length, result.Length);
        Assert.All(result.ToCharArray(), c => Assert.Equal('*', c));
    }

    [Fact]
    public void Pseudonymizer_ReversibleMode_RequiresMappingTable()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Reversible);
        Assert.Throws<InvalidOperationException>(
            () => ps.Pseudonymize(@"C:\Users\test", new byte[] { 1 }));
    }

    [Fact]
    public void Pseudonymizer_ReversibleMode_WithTable_ReturnsPseudonym()
    {
        var table = new MappingTable();
        var ps = new Pseudonymizer(PseudonymizationMode.Reversible, table);
        var salt = Encoding.UTF8.GetBytes("rev-salt");
        var path = @"C:\Users\testuser\MyProject";

        var result = ps.Pseudonymize(path, salt);
        Assert.StartsWith("[REV:", result);
        Assert.EndsWith("]", result);
        Assert.True(result.Length <= path.Length);
    }

    [Fact]
    public void Pseudonymizer_ReversibleMode_SamePathReturnsSamePseudonym()
    {
        var table = new MappingTable();
        var ps = new Pseudonymizer(PseudonymizationMode.Reversible, table);
        var salt = Encoding.UTF8.GetBytes("stable-salt");
        var path = @"C:\Users\testuser\MyProject";

        var first = ps.Pseudonymize(path, salt);
        var second = ps.Pseudonymize(path, salt);
        Assert.Equal(first, second);
    }

    [Fact]
    public void Pseudonymizer_ReversibleMode_ShortPathFallsBackToStars()
    {
        var table = new MappingTable();
        var ps = new Pseudonymizer(PseudonymizationMode.Reversible, table);
        var salt = new byte[16];
        // "[REV:XXXXXXXX]" is 14 chars — if path < 14 chars, should use stars
        var path = "tiny";
        var result = ps.Pseudonymize(path, salt);
        Assert.Equal(path.Length, result.Length);
        Assert.All(result.ToCharArray(), c => Assert.Equal('*', c));
    }

    [Fact]
    public void Pseudonymizer_NullPathThrows()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Off);
        Assert.Throws<ArgumentNullException>(() => ps.Pseudonymize(null!, new byte[] { 1 }));
    }

    [Fact]
    public void Pseudonymizer_NullSaltThrows()
    {
        var ps = new Pseudonymizer(PseudonymizationMode.Off);
        Assert.Throws<ArgumentNullException>(() => ps.Pseudonymize("path", null!));
    }

    // =====================================================================
    // MappingTable
    // =====================================================================

    [Fact]
    public void MappingTable_GetOrAdd_ReturnsFactoryResult()
    {
        var table = new MappingTable();
        var result = table.GetOrAdd("real-value", k => "pseudo-" + k);
        Assert.Equal("pseudo-real-value", result);
    }

    [Fact]
    public void MappingTable_GetOrAdd_ReturnsCachedOnSecondCall()
    {
        var table = new MappingTable();
        var callCount = 0;
        string Factory(string k) { callCount++; return "p-" + k; }

        var first = table.GetOrAdd("key1", Factory);
        var second = table.GetOrAdd("key1", Factory);
        Assert.Equal(first, second);
        Assert.Equal(1, callCount);
    }

    [Fact]
    public void MappingTable_GetOrAdd_NullRealValueThrows()
    {
        var table = new MappingTable();
        Assert.Throws<ArgumentNullException>(() => table.GetOrAdd(null!, k => k));
    }

    [Fact]
    public void MappingTable_GetOrAdd_NullFactoryThrows()
    {
        var table = new MappingTable();
        Assert.Throws<ArgumentNullException>(() => table.GetOrAdd("key", null!));
    }

    [Fact]
    public void MappingTable_Snapshot_ReturnsAllMappings()
    {
        var table = new MappingTable();
        table.GetOrAdd("a", k => "p-a");
        table.GetOrAdd("b", k => "p-b");
        table.GetOrAdd("c", k => "p-c");

        var snap = table.Snapshot();
        Assert.Equal(3, snap.Count);
        Assert.Equal("p-a", snap["a"]);
        Assert.Equal("p-b", snap["b"]);
        Assert.Equal("p-c", snap["c"]);
    }

    [Fact]
    public void MappingTable_Snapshot_EmptyTableReturnsEmpty()
    {
        var table = new MappingTable();
        var snap = table.Snapshot();
        Assert.Empty(snap);
    }

    [Fact]
    public void MappingTable_Snapshot_IsIsolatedCopy()
    {
        var table = new MappingTable();
        table.GetOrAdd("x", k => "p-x");
        var snap1 = table.Snapshot();

        table.GetOrAdd("y", k => "p-y");
        var snap2 = table.Snapshot();

        Assert.Single(snap1);
        Assert.Equal(2, snap2.Count);
    }

    // =====================================================================
    // RedactorPipeline
    // =====================================================================

    [Fact]
    public void RedactorPipeline_NullDetectorsThrows()
    {
        Assert.Throws<ArgumentNullException>(() => new RedactorPipeline(null!));
    }

    [Fact]
    public void RedactorPipeline_NullInputThrows()
    {
        var pipeline = new RedactorPipeline(Array.Empty<ISecretDetector>());
        Assert.Throws<ArgumentNullException>(() => pipeline.Redact(null!));
    }

    [Fact]
    public void RedactorPipeline_EmptyInputReturnsEmpty()
    {
        var pipeline = new RedactorPipeline(Array.Empty<ISecretDetector>());
        Assert.Equal(string.Empty, pipeline.Redact(string.Empty));
    }

    [Fact]
    public void RedactorPipeline_NoDetectorsReturnsInputUnchanged()
    {
        var pipeline = new RedactorPipeline(Array.Empty<ISecretDetector>());
        const string input = "nothing secret here";
        Assert.Equal(input, pipeline.Redact(input));
    }

    [Fact]
    public void RedactorPipeline_ShortMatchUsesStarsInsteadOfRedacted()
    {
        // Match shorter than "[REDACTED]" (9 chars) should use stars
        var detector = new StubDetector("stub", new[] { new RedactionMatch(0, 4, "stub") });
        var pipeline = new RedactorPipeline(new[] { detector });
        var result = pipeline.Redact("test data here");
        Assert.StartsWith("****", result);
    }

    [Fact]
    public void RedactorPipeline_LongMatchUsesRedactedMarker()
    {
        // Match >= 9 chars should use [REDACTED]
        var detector = new StubDetector("stub", new[] { new RedactionMatch(0, 15, "stub") });
        var pipeline = new RedactorPipeline(new[] { detector });
        var result = pipeline.Redact("0123456789ABCDE extra");
        Assert.StartsWith("[REDACTED]", result);
    }

    [Fact]
    public void RedactorPipeline_OverlappingMatchesMerged()
    {
        var detector = new StubDetector("stub", new[]
        {
            new RedactionMatch(0, 10, "stub"),
            new RedactionMatch(5, 10, "stub"),
        });
        var pipeline = new RedactorPipeline(new[] { detector });
        var input = "0123456789ABCDE-extra-padding";
        var result = pipeline.Redact(input);
        // The merged region is 0..15 (15 chars), replaced with [REDACTED]
        Assert.StartsWith("[REDACTED]", result);
        Assert.Contains("extra", result);
    }

    [Fact]
    public void RedactorPipeline_MultipleNonOverlappingMatches()
    {
        var detector = new StubDetector("stub", new[]
        {
            new RedactionMatch(0, 3, "stub"),
            new RedactionMatch(10, 3, "stub"),
        });
        var pipeline = new RedactorPipeline(new[] { detector });
        var result = pipeline.Redact("ABC-------XYZ---tail");
        Assert.StartsWith("***", result);
        Assert.Contains("***", result.Substring(7));
    }

    [Fact]
    public async Task RedactorPipeline_RedactAsync_ProcessesBytesCorrectly()
    {
        var detector = new StubDetector("stub", new[] { new RedactionMatch(0, 15, "stub") });
        var pipeline = new RedactorPipeline(new[] { detector });
        var inputBytes = Encoding.UTF8.GetBytes("secret-password-value-here");
        var input = new ReadOnlySequence<byte>(inputBytes);
        var output = new ArrayBufferWriter<byte>();

        var written = await pipeline.RedactAsync(input, output, CancellationToken.None);

        Assert.True(written > 0);
        var resultStr = Encoding.UTF8.GetString(output.WrittenSpan);
        Assert.StartsWith("[REDACTED]", resultStr);
    }

    [Fact]
    public async Task RedactorPipeline_RedactAsync_ThrowsOnCancelled()
    {
        var pipeline = new RedactorPipeline(Array.Empty<ISecretDetector>());
        var input = new ReadOnlySequence<byte>(new byte[] { 65, 66, 67 });
        var output = new ArrayBufferWriter<byte>();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => pipeline.RedactAsync(input, output, cts.Token).AsTask());
    }

    [Fact]
    public async Task RedactorPipeline_RedactAsync_NullOutputThrows()
    {
        var pipeline = new RedactorPipeline(Array.Empty<ISecretDetector>());
        var input = new ReadOnlySequence<byte>(new byte[] { 65 });

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => pipeline.RedactAsync(input, null!, CancellationToken.None).AsTask());
    }

    // =====================================================================
    // PathSidDetector
    // =====================================================================

    [Fact]
    public void PathSidDetector_NullInputThrows()
    {
        var detector = new PathSidDetector();
        Assert.Throws<ArgumentNullException>(() => detector.Detect(null!));
    }

    [Fact]
    public void PathSidDetector_DetectsUnixHomePath()
    {
        var detector = new PathSidDetector();
        var matches = detector.Detect("File at /home/jdoe/projects/src/main.cs");
        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("P-SID-2", m.RuleId));
    }

    [Fact]
    public void PathSidDetector_DetectsMacUserPath()
    {
        var detector = new PathSidDetector();
        var matches = detector.Detect("Found in /Users/alice/Documents/file.txt");
        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("P-SID-2", m.RuleId));
    }

    [Fact]
    public void PathSidDetector_DetectsUncPath()
    {
        var detector = new PathSidDetector();
        var matches = detector.Detect(@"Accessing \\server\share\folder\file.dat");
        Assert.NotEmpty(matches);
        Assert.All(matches, m => Assert.Equal("P-SID-2", m.RuleId));
    }

    [Fact]
    public void PathSidDetector_NegativeLookbehind_UnixPath()
    {
        var detector = new PathSidDetector();
        // Preceded by alphanumeric should not match (INV-5)
        var matches = detector.Detect("prefix/home/jdoe/file");
        // "/home/jdoe/file" is preceded by "x" — should not match
        Assert.Empty(matches);
    }

    [Fact]
    public void PathSidDetector_NoMatchOnPlainText()
    {
        var detector = new PathSidDetector();
        var matches = detector.Detect("Just a plain text string with no paths");
        Assert.Empty(matches);
    }

    [Fact]
    public void PathSidDetector_WindowsPathWithSpaces()
    {
        var detector = new PathSidDetector();
        // Paths with spaces after the username segment
        var matches = detector.Detect(@"Log from C:\Users\testuser\My Documents\log.txt");
        Assert.NotEmpty(matches);
    }

    [Fact]
    public void PathSidDetector_MultiplePathsInSameInput()
    {
        var detector = new PathSidDetector();
        var input = @"Copy C:\Users\alice\src to C:\Users\bob\dest";
        var matches = detector.Detect(input);
        Assert.True(matches.Count >= 2);
    }

    [Fact]
    public void PathSidDetector_RuleIdIsCorrect()
    {
        var detector = new PathSidDetector();
        Assert.Equal("P-SID-2", detector.RuleId);
    }

    // =====================================================================
    // Stub detector for pipeline tests
    // =====================================================================

    private sealed class StubDetector : ISecretDetector
    {
        private readonly IReadOnlyList<RedactionMatch> matches;

        public StubDetector(string ruleId, IReadOnlyList<RedactionMatch> matches)
        {
            this.RuleId = ruleId;
            this.matches = matches;
        }

        public string RuleId { get; }

        public IReadOnlyList<RedactionMatch> Detect(string input) => this.matches;
    }
}
