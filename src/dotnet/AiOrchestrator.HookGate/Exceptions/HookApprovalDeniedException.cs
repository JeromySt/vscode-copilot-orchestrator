// <copyright file="HookApprovalDeniedException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Exceptions;

/// <summary>Raised when a hook check-in is rejected (INV-7).</summary>
public sealed class HookApprovalDeniedException : Exception
{
    /// <summary>Initializes a new <see cref="HookApprovalDeniedException"/>.</summary>
    /// <param name="reason">Short machine-readable reason for the denial.</param>
    /// <param name="kind">The hook kind that was denied.</param>
    public HookApprovalDeniedException(string reason, HookKind kind)
        : base($"Hook approval denied: kind={kind}, reason={reason}")
    {
        this.Reason = reason ?? throw new ArgumentNullException(nameof(reason));
        this.Kind = kind;
    }

    /// <summary>Gets the short machine-readable reason for the denial.</summary>
    public string Reason { get; }

    /// <summary>Gets the hook kind that was denied.</summary>
    public HookKind Kind { get; }
}
