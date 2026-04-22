// <copyright file="DesignDocRuleExtractor.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Acceptance;

/// <summary>
/// Extracts named rule ids from the §§3.27–3.33 sections of the design doc. A rule id is
/// any token matching <c>(UPPER+-)+UPPER0-9+(-N)?</c> (e.g. <c>HK-GATE-POLICY-4</c>).
/// </summary>
internal sealed partial class DesignDocRuleExtractor
{
    private const string SectionStart = "## 3.27";
    private static readonly Regex SectionBoundary = new(@"^##\s+3\.(\d+)", RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>
    /// Returns the de-duplicated, sorted set of rule ids appearing inside §§3.27 through §3.33
    /// (inclusive). Ids appearing outside that span are ignored.
    /// </summary>
    public ImmutableArray<string> Extract(string markdown)
    {
        ArgumentNullException.ThrowIfNull(markdown);

        // Slice the doc to the §3.27..§3.33 inclusive range. End boundary is the first ## 3.N
        // header with N >= 34, or end-of-doc if no such header exists.
        int startIdx = markdown.IndexOf(SectionStart, StringComparison.Ordinal);
        if (startIdx < 0)
        {
            return ImmutableArray<string>.Empty;
        }

        int endIdx = markdown.Length;
        foreach (Match m in SectionBoundary.Matches(markdown, startIdx + SectionStart.Length))
        {
            if (int.TryParse(m.Groups[1].Value, out int n) && n >= 34)
            {
                endIdx = m.Index;
                break;
            }
        }

        string slice = markdown.Substring(startIdx, endIdx - startIdx);
        var unique = new SortedSet<string>(StringComparer.Ordinal);
        foreach (Match m in RuleIdPattern().Matches(slice))
        {
            unique.Add(m.Value);
        }

        return [.. unique];
    }

    [GeneratedRegex(@"\b(?:[A-Z]+-)+[A-Z0-9]+\b(?:-\d+)?", RegexOptions.CultureInvariant)]
    private static partial Regex RuleIdPattern();
}
