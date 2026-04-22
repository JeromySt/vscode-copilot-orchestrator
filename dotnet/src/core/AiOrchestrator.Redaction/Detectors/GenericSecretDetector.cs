// <copyright file="GenericSecretDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>
/// Detects generic secret / password / token assignments in source code and config files
/// — rule <c>T3-RED-6</c>.
/// </summary>
public sealed partial class GenericSecretDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-6";

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

    [GeneratedRegex(
        @"(?i)(?:password|passwd|secret|token|credential)\s*[:=]\s*[^\s,;'""`]{8,256}",
        RegexOptions.None,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetPattern();
}
