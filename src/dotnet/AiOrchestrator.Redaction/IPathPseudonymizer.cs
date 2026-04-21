// <copyright file="IPathPseudonymizer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Redaction;

/// <summary>
/// Converts a real filesystem path or user identifier into a stable pseudonym
/// that conceals the original value while remaining consistent within a bundle.
/// </summary>
public interface IPathPseudonymizer
{
    /// <summary>
    /// Returns a pseudonym for <paramref name="path"/> that is stable for the given
    /// <paramref name="bundleSalt"/>.  Calling with the same arguments always produces
    /// the same output (INV-7).
    /// </summary>
    /// <param name="path">The real path or identifier to pseudonymize.</param>
    /// <param name="bundleSalt">
    /// A per-bundle salt that scopes the pseudonym to a single execution bundle.
    /// </param>
    /// <returns>A pseudonym string whose length does not exceed that of <paramref name="path"/>.</returns>
    string Pseudonymize(string path, byte[] bundleSalt);
}
