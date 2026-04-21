// <copyright file="INonceManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator.HookGate contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Nonce;

/// <summary>Issues and rotates daemon nonces used as the HMAC key for hook-approval tokens (INV-5).</summary>
public interface INonceManager
{
    /// <summary>Gets the current (most-recent) nonce.</summary>
    Nonce Current { get; }

    /// <summary>Gets the previous nonce, if still within the overlap window.</summary>
    Nonce? Previous { get; }

    /// <summary>Raised whenever <see cref="Current"/> rotates.</summary>
    event EventHandler<NonceRotated> Rotated;
}
