// <copyright file="IPathValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Abstractions.Paths;

/// <summary>
/// Enforces path-traversal and containment invariants. All filesystem access from
/// untrusted callers must flow through an implementation of this interface.
/// </summary>
public interface IPathValidator
{
    /// <summary>
    /// Asserts that <paramref name="path"/> resolves strictly under <paramref name="allowedRoot"/>,
    /// rejecting traversal attempts (<c>..</c>), reparse points, and disallowed names.
    /// </summary>
    /// <param name="path">The candidate absolute path.</param>
    /// <param name="allowedRoot">The allowed containment root.</param>
    /// <exception cref="UnauthorizedAccessException">The path escapes the allowed root or is otherwise unsafe.</exception>
    void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot);

    /// <summary>
    /// Opens a read-only stream over <paramref name="relative"/>, resolved beneath
    /// <paramref name="allowedRoot"/> with traversal protection.
    /// </summary>
    /// <param name="allowedRoot">The allowed containment root.</param>
    /// <param name="relative">The relative path beneath the root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A read-only stream over the resolved file.</returns>
    ValueTask<Stream> OpenReadUnderRootAsync(AbsolutePath allowedRoot, RelativePath relative, CancellationToken ct);
}
