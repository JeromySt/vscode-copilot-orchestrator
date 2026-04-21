// <copyright file="CommitSha.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Linq;

namespace AiOrchestrator.Models.Ids;

/// <summary>Represents a 40-character Git commit SHA.</summary>
public readonly record struct CommitSha
{
    /// <summary>Gets the hexadecimal SHA string.</summary>
    public string Hex { get; }

    /// <summary>Initializes a new commit SHA, validating the hex format.</summary>
    public CommitSha(string hex)
    {
        if (hex == null)
        {
            throw new ArgumentNullException(nameof(hex));
        }

        if (hex.Length != 40 || !hex.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')))
        {
            throw new ArgumentException("CommitSha must be a 40-character hexadecimal string.", nameof(hex));
        }

        Hex = hex.ToLowerInvariant();
    }

    /// <inheritdoc/>
    public override string ToString() => Hex;
}
