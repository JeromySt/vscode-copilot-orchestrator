// <copyright file="AwsAccessKeyDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>Detects AWS Access Key IDs — rule <c>T3-RED-2</c>.</summary>
public sealed partial class AwsAccessKeyDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-2";

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

    [GeneratedRegex(@"(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetPattern();
}
