// <copyright file="ConnectionStringDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>
/// Detects passwords embedded in connection strings and URIs — rule <c>T3-RED-4</c>.
/// </summary>
public sealed partial class ConnectionStringDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-4";

    /// <inheritdoc />
    public IReadOnlyList<RedactionMatch> Detect(string input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var results = new List<RedactionMatch>();
        foreach (Match m in GetUriPasswordPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        foreach (Match m in GetConnStrPasswordPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        return results;
    }

    // Matches user:password@host in a URI — captures the password portion
    [GeneratedRegex(@"://[^:\s@/]{1,256}:[^@\s]{4,256}@", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetUriPasswordPattern();

    // Matches Password=<value> in ADO.NET-style connection strings
    [GeneratedRegex(@"(?i)(?:Password|Pwd)\s*=\s*[^;{}\s'""`]{4,256}", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetConnStrPasswordPattern();
}
