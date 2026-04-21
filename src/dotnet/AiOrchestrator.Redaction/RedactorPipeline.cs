// <copyright file="RedactorPipeline.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Redaction;

namespace AiOrchestrator.Redaction;

/// <summary>
/// Runs a configurable set of <see cref="ISecretDetector"/> instances over text,
/// merges overlapping matches, and applies redaction replacements in a single pass.
/// Implements all behavioral invariants INV-2 through INV-7.
/// </summary>
public sealed class RedactorPipeline : IRedactor
{
    private const string RedactedMarker = "[REDACTED]";
    private const int RedactedMarkerLength = 9;

    private readonly IReadOnlyList<ISecretDetector> detectors;

    /// <summary>Initializes a new instance of the <see cref="RedactorPipeline"/> class with the specified detectors.</summary>
    /// <param name="detectors">The ordered list of secret detectors to apply.</param>
    public RedactorPipeline(IReadOnlyList<ISecretDetector> detectors)
    {
        ArgumentNullException.ThrowIfNull(detectors);
        this.detectors = detectors;
    }

    /// <inheritdoc />
    public string Redact(string input)
    {
        ArgumentNullException.ThrowIfNull(input);

        if (input.Length == 0)
        {
            return input;
        }

        var matches = this.CollectMatches(input);
        if (matches.Count == 0)
        {
            return input;
        }

        matches.Sort(static (a, b) => a.Start.CompareTo(b.Start));
        var merged = MergeOverlapping(matches);
        return ApplyReplacements(input, merged);
    }

    /// <inheritdoc />
    public ValueTask<int> RedactAsync(ReadOnlySequence<byte> input, IBufferWriter<byte> output, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(output);
        ct.ThrowIfCancellationRequested();

        var text = input.IsSingleSegment
            ? Encoding.UTF8.GetString(input.FirstSpan)
            : Encoding.UTF8.GetString(input.ToArray());

        var redacted = this.Redact(text);
        var bytes = Encoding.UTF8.GetBytes(redacted);

        var span = output.GetSpan(bytes.Length);
        bytes.CopyTo(span);
        output.Advance(bytes.Length);

        return ValueTask.FromResult(bytes.Length);
    }

    private static List<RedactionMatch> MergeOverlapping(List<RedactionMatch> sorted)
    {
        var result = new List<RedactionMatch>(sorted.Count);
        foreach (var m in sorted)
        {
            if (result.Count == 0)
            {
                result.Add(m);
            }
            else
            {
                var last = result[^1];
                var lastEnd = last.Start + last.Length;
                if (m.Start < lastEnd)
                {
                    // Overlapping — extend to cover both
                    var newEnd = Math.Max(lastEnd, m.Start + m.Length);
                    result[^1] = new RedactionMatch(last.Start, newEnd - last.Start, last.RuleId);
                }
                else
                {
                    result.Add(m);
                }
            }
        }

        return result;
    }

    private static string ApplyReplacements(string input, List<RedactionMatch> mergedDesc)
    {
        var sb = new StringBuilder(input);

        // Apply from end to start so earlier indices stay valid
        for (var i = mergedDesc.Count - 1; i >= 0; i--)
        {
            var m = mergedDesc[i];
            var replacement = m.Length >= RedactedMarkerLength
                ? RedactedMarker
                : new string('*', m.Length);

            _ = sb.Remove(m.Start, m.Length);
            _ = sb.Insert(m.Start, replacement);
        }

        return sb.ToString();
    }

    private List<RedactionMatch> CollectMatches(string input)
    {
        var all = new List<RedactionMatch>();
        foreach (var detector in this.detectors)
        {
            all.AddRange(detector.Detect(input));
        }

        return all;
    }
}
