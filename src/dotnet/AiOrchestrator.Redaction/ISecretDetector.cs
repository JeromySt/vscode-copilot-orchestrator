// <copyright file="ISecretDetector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace AiOrchestrator.Redaction;

/// <summary>Detects sensitive secrets within a text string and returns the set of matched spans.</summary>
public interface ISecretDetector
{
    /// <summary>Gets the unique rule identifier for this detector (e.g., <c>T3-RED-1</c>).</summary>
    string RuleId { get; }

    /// <summary>Scans <paramref name="input"/> and returns all matches found by this detector.</summary>
    /// <param name="input">The text to scan.</param>
    /// <returns>A read-only list of matches; empty if none are found.</returns>
    IReadOnlyList<RedactionMatch> Detect(string input);
}
