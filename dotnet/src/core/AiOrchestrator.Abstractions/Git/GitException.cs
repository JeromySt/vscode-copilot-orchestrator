// <copyright file="GitException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Git;

#pragma warning disable CA1711 // Identifiers should not have incorrect suffix — this IS a domain error record, not a System.Exception

/// <summary>Carries structured error information from a failed git operation.</summary>
/// <param name="Operation">The git operation that failed (e.g., <c>fetch</c>, <c>merge</c>).</param>
/// <param name="ErrorMessage">The error message from the git command output.</param>
/// <param name="ExitCode">The process exit code returned by the git command, if available.</param>
public sealed record GitException(
    string Operation,
    string ErrorMessage,
    int? ExitCode);
