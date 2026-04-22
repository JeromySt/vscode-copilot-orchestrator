// <copyright file="RedactionMatch.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Redaction;

/// <summary>Represents a single redaction match found within an input string.</summary>
/// <param name="Start">The zero-based character offset at which the match begins.</param>
/// <param name="Length">The number of characters covered by the match.</param>
/// <param name="RuleId">The identifier of the detection rule that produced this match.</param>
public readonly record struct RedactionMatch(int Start, int Length, string RuleId);
