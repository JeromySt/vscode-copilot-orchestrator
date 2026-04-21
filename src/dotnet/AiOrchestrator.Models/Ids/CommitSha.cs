// <copyright file="CommitSha.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Linq;

namespace AiOrchestrator.Models.Ids;

/// <summary>Represents a 40-character Git commit SHA.</summary>
public readonly record struct CommitSha
{
    /// <summary>Initializes a new instance of the <see cref="CommitSha"/> struct.</summary>
    /// <param name="hex">The 40-character hexadecimal commit hash.</param>
    /// <exception cref="ArgumentNullException">Thrown when <paramref name="hex"/> is <see langword="null"/>.</exception>
    /// <exception cref="ArgumentException">Thrown when <paramref name="hex"/> is not a valid 40-character hex string.</exception>
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

        this.Hex= hex.ToLowerInvariant();
    }

    /// <summary>Gets the hexadecimal SHA string.</summary>
    public string Hex { get; }

    /// <inheritdoc/>
    public override string ToString() => this.Hex;
}
