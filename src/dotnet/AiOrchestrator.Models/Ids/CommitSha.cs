// <copyright file="CommitSha.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Ids;

/// <summary>A validated 40-character hexadecimal Git commit SHA.</summary>
public readonly record struct CommitSha
{
    /// <summary>Initializes a new instance of the <see cref="CommitSha"/> struct.</summary>
    /// <param name="hex">The 40-character hex string.</param>
    /// <exception cref="ArgumentException">The value is not a valid 40-character hex string.</exception>
    public CommitSha(string hex)
    {
        if (hex is null || hex.Length != 40 || !IsAllHex(hex))
        {
            throw new ArgumentException("CommitSha must be exactly 40 hex characters.", nameof(hex));
        }

        this.Hex = hex.ToLowerInvariant();
    }

    /// <summary>Gets the 40-character lowercase hex representation of the commit SHA.</summary>
    public string Hex { get; }

    /// <inheritdoc/>
    public override string ToString() => this.Hex;

    private static bool IsAllHex(string s)
    {
        foreach (var c in s)
        {
            if (!Uri.IsHexDigit(c))
            {
                return false;
            }
        }

        return true;
    }
}
