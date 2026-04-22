// <copyright file="PathSidDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>
/// Detects user home-directory paths on Windows and Unix, and UNC paths, replacing them
/// with pseudonyms — rule <c>P-SID-2</c>.
/// Negative-lookbehind and lookahead anchors (INV-5) prevent false-positive partial matches.
/// </summary>
public sealed partial class PathSidDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "P-SID-2";

    /// <inheritdoc />
    public IReadOnlyList<RedactionMatch> Detect(string input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var results = new List<RedactionMatch>();
        foreach (Match m in GetWindowsPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        foreach (Match m in GetUnixPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        foreach (Match m in GetUncPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        return results;
    }

    // Windows user profile paths: C:\Users\<username> or C:\Users\<username>\...
    // Negative-lookbehind (?<![A-Za-z0-9]) ensures we don't start inside a longer identifier (INV-5).
    [GeneratedRegex(
        @"(?<![A-Za-z0-9])[A-Za-z]:\\Users\\[A-Za-z0-9_.\-]+(?:\\[^\\""\s]*)*",
        RegexOptions.None,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetWindowsPattern();

    // Unix home paths: /home/<username> or /Users/<username>
    // Negative-lookahead (?![A-Za-z0-9]) after the username segment prevents partial matches (INV-5).
    [GeneratedRegex(
        @"(?<![A-Za-z0-9])/(?:home|Users)/[A-Za-z0-9_.\-]+(?:/[^/""\s]*)*",
        RegexOptions.None,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetUnixPattern();

    // UNC paths: \\server\share
    [GeneratedRegex(@"\\\\[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.\-]+(?:\\[^\\""\s]*)*", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetUncPattern();
}
