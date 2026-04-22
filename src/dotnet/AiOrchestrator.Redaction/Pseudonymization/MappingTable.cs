// <copyright file="MappingTable.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace AiOrchestrator.Redaction.Pseudonymization;

/// <summary>
/// Thread-safe forward mapping table that associates real values with their pseudonyms.
/// Used in <see cref="PseudonymizationMode.Reversible"/> mode to allow recovery of original values.
/// </summary>
public sealed class MappingTable
{
    private readonly ConcurrentDictionary<string, string> map = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Returns the existing pseudonym for <paramref name="realValue"/>, or adds and returns the
    /// result of <paramref name="pseudonymFactory"/> if no mapping exists yet.
    /// </summary>
    /// <param name="realValue">The original sensitive value.</param>
    /// <param name="pseudonymFactory">A factory that produces the pseudonym for a new entry.</param>
    /// <returns>The pseudonym associated with <paramref name="realValue"/>.</returns>
    public string GetOrAdd(string realValue, System.Func<string, string> pseudonymFactory)
    {
        ArgumentNullException.ThrowIfNull(realValue);
        ArgumentNullException.ThrowIfNull(pseudonymFactory);
        return this.map.GetOrAdd(realValue, pseudonymFactory);
    }

    /// <summary>Gets a snapshot of all current real-value → pseudonym mappings.</summary>
    /// <returns>An immutable copy of the current mapping table.</returns>
    public IReadOnlyDictionary<string, string> Snapshot()
    {
        return new Dictionary<string, string>(this.map, System.StringComparer.Ordinal);
    }
}
