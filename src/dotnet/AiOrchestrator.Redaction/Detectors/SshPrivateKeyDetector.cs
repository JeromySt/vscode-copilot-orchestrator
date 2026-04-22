// <copyright file="SshPrivateKeyDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace AiOrchestrator.Redaction.Detectors;

/// <summary>Detects PEM-encoded SSH and TLS private-key headers — rule <c>T3-RED-5</c>.</summary>
public sealed partial class SshPrivateKeyDetector : ISecretDetector
{
    /// <inheritdoc />
    public string RuleId => "T3-RED-5";

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

    [GeneratedRegex(@"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex GetPattern();
}
