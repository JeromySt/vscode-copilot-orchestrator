// <copyright file="IPseudonymizer.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Diagnose;

/// <summary>
/// Replaces sensitive identifiers with stable pseudonyms and, when operating in reversible mode,
/// retains an encrypted mapping that the configured recipient can later invert.
/// </summary>
public interface IPseudonymizer
{
    /// <summary>Returns a stable pseudonym for <paramref name="original"/>.</summary>
    /// <param name="original">The raw identifier to replace.</param>
    /// <param name="kind">The kind of identifier, used to format the pseudonym (e.g. <c>user-A1B2</c>).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A pseudonym string; identical input yields identical output within the session.</returns>
    ValueTask<string> PseudonymizeAsync(string original, PseudonymKind kind, CancellationToken ct);

    /// <summary>Reverses a pseudonym using a recipient private key, if the bundle was produced in <see cref="PseudonymizationMode.Reversible"/>.</summary>
    /// <param name="pseudonym">The pseudonym to invert.</param>
    /// <param name="recipientPubKeyFingerprint">The recipient fingerprint the mapping was encrypted against.</param>
    /// <param name="privateKey">The recipient's private key bytes (PKCS#8).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The original identifier, or <see langword="null"/> if the pseudonym is unknown.</returns>
    ValueTask<string?> ReverseAsync(string pseudonym, string recipientPubKeyFingerprint, byte[] privateKey, CancellationToken ct);
}
