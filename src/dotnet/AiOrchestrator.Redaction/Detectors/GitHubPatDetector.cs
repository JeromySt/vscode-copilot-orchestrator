// <copyright file="GitHubPatDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>Detects GitHub Personal Access Tokens (PATs) — rule <c>T3-RED-1</c>.</summary>
public sealed partial class GitHubPatDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-1";

    /// <inheritdoc />
    public IReadOnlyList<RedactionMatch> Detect(string input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var results = new List<RedactionMatch>();
        foreach (Match m in GetPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        return results;
    }

    [GeneratedRegex(@"(?:ghp|ghs|gho|github_pat)_[A-Za-z0-9_]{36,82}", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetPattern();
}
