// <copyright file="Pseudonymizer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;
using System.Text;

namespace AiOrchestrator.Redaction.Pseudonymization;

/// <summary>
/// Implements <see cref="AiOrchestrator.Redaction.IPathPseudonymizer"/> for all three
/// pseudonymization modes: <see cref="PseudonymizationMode.Off"/>,
/// <see cref="PseudonymizationMode.Anonymous"/>, and
/// <see cref="PseudonymizationMode.Reversible"/>.
/// </summary>
public sealed class Pseudonymizer : IPathPseudonymizer
{
    private const string RedactedMarker = "[REDACTED]";
    private const string AnonPrefix = "[ANON:";
    private const int AnonHexLen = 8;
    private const string RevPrefix = "[REV:";
    private const int RevHexLen = 8;

    private readonly PseudonymizationMode mode;
    private readonly MappingTable? table;

    /// <summary>
    /// Initializes a new instance of the <see cref="Pseudonymizer"/> class with the specified mode.
    /// For <see cref="PseudonymizationMode.Reversible"/> mode, a <see cref="MappingTable"/>
    /// must be supplied via <paramref name="table"/>.
    /// </summary>
    /// <param name="mode">The pseudonymization mode to use.</param>
    /// <param name="table">
    /// Optional mapping table for <see cref="PseudonymizationMode.Reversible"/> mode.
    /// </param>
    public Pseudonymizer(PseudonymizationMode mode, MappingTable? table = null)
    {
        this.mode = mode;
        this.table = table;
    }

    /// <inheritdoc />
    public string Pseudonymize(string path, byte[] bundleSalt)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(bundleSalt);

        return this.mode switch
        {
            PseudonymizationMode.Anonymous => BuildAnonymous(path, bundleSalt),
            PseudonymizationMode.Reversible => this.BuildReversible(path, bundleSalt),
            _ => RedactedMarker,
        };
    }

    private static string BuildAnonymous(string path, byte[] bundleSalt)
    {
        // SHA-256(bundleSalt ∥ UTF-8(path)) → first 8 hex chars → [ANON:xxxxxxxx]
        var pathBytes = Encoding.UTF8.GetBytes(path);
        var combined = new byte[bundleSalt.Length + pathBytes.Length];
        Buffer.BlockCopy(bundleSalt, 0, combined, 0, bundleSalt.Length);
        Buffer.BlockCopy(pathBytes, 0, combined, bundleSalt.Length, pathBytes.Length);
        var hash = SHA256.HashData(combined);
        var hex = Convert.ToHexString(hash)[..AnonHexLen];
        var candidate = string.Concat(AnonPrefix, hex, "]");

        // INV-4: ensure replacement ≤ original length
        return candidate.Length <= path.Length ? candidate : new string('*', path.Length);
    }

    private string BuildReversible(string path, byte[] bundleSalt)
    {
        var resolvedTable = this.table ?? throw new InvalidOperationException(
            "A MappingTable is required for Reversible pseudonymization mode.");

        return resolvedTable.GetOrAdd(path, realValue =>
        {
            // Produce a pseudonym derived from the hash so it is stable but not guessable
            var pathBytes = Encoding.UTF8.GetBytes(realValue);
            var combined = new byte[bundleSalt.Length + pathBytes.Length];
            Buffer.BlockCopy(bundleSalt, 0, combined, 0, bundleSalt.Length);
            Buffer.BlockCopy(pathBytes, 0, combined, bundleSalt.Length, pathBytes.Length);
            var hash = SHA256.HashData(combined);
            var hex = Convert.ToHexString(hash)[..RevHexLen];
            var candidate = string.Concat(RevPrefix, hex, "]");
            return candidate.Length <= realValue.Length ? candidate : new string('*', realValue.Length);
        });
    }
}
