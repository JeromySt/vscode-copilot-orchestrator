// <copyright file="JwtDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>Detects JSON Web Tokens (header.payload.signature) — rule <c>T3-RED-7</c>.</summary>
public sealed partial class JwtDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-7";

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

    // JWT: three Base64url segments, header must start with eyJ ({"...)
    [GeneratedRegex(@"eyJ[A-Za-z0-9_\-]{4,}\.eyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetPattern();
}
