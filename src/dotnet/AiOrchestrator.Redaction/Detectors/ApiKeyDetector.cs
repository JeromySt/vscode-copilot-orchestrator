// <copyright file="ApiKeyDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>Detects HTTP Bearer tokens and generic API key assignments — rule <c>T3-RED-3</c>.</summary>
public sealed partial class ApiKeyDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-3";

    /// <inheritdoc />
    public IReadOnlyList<RedactionMatch> Detect(string input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var results = new List<RedactionMatch>();
        foreach (Match m in GetBearerPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        foreach (Match m in GetApiKeyPattern().Matches(input))
        {
            results.Add(new RedactionMatch(m.Index, m.Length, this.RuleId));
        }

        return results;
    }

    [GeneratedRegex(@"Bearer\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetBearerPattern();

    [GeneratedRegex(@"(?i)api[_\-]?key\s*[:=]\s*[^\s,;'""`]{8,}", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetApiKeyPattern();
}
