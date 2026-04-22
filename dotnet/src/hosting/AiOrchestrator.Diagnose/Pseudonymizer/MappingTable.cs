// <copyright file="MappingTable.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace AiOrchestrator.Diagnose.Pseudonymizer;

/// <summary>Bidirectional table of pseudonym ↔ original mappings produced by <see cref="Pseudonymizer"/>.</summary>
internal sealed class MappingTable
{
    private readonly Dictionary<string, string> forward = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> reverse = new(StringComparer.Ordinal);
    private readonly object gate = new();

    public bool TryGetForward(string original, out string? pseudonym)
    {
        lock (this.gate)
        {
            return this.forward.TryGetValue(original, out pseudonym);
        }
    }

    public void Record(string original, string pseudonym)
    {
        lock (this.gate)
        {
            this.forward[original] = pseudonym;
            this.reverse[pseudonym] = original;
        }
    }

    public IReadOnlyDictionary<string, string> GetSortedForward()
    {
        lock (this.gate)
        {
            var sorted = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var kvp in this.forward)
            {
                sorted[kvp.Key] = kvp.Value;
            }

            return sorted;
        }
    }

    public IReadOnlyDictionary<string, string> GetReverse()
    {
        lock (this.gate)
        {
            return new Dictionary<string, string>(this.reverse, StringComparer.Ordinal);
        }
    }

    public int Count
    {
        get
        {
            lock (this.gate)
            {
                return this.forward.Count;
            }
        }
    }
}
