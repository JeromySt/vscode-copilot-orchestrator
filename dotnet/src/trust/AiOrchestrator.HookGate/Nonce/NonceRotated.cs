// <copyright file="NonceRotated.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Nonce;

/// <summary>Event payload raised when a <see cref="Nonce"/> rotates (INV-5).</summary>
public sealed class NonceRotated : EventArgs
{
    /// <summary>Initializes a new <see cref="NonceRotated"/>.</summary>
    /// <param name="previous">The nonce that was just retired. <see langword="null"/> on the first issuance.</param>
    /// <param name="current">The newly-issued nonce.</param>
    public NonceRotated(Nonce? previous, Nonce current)
    {
        this.Previous = previous;
        this.Current = current ?? throw new ArgumentNullException(nameof(current));
    }

    /// <summary>Gets the nonce that was just retired.</summary>
    public Nonce? Previous { get; }

    /// <summary>Gets the newly-issued nonce.</summary>
    public Nonce Current { get; }
}
