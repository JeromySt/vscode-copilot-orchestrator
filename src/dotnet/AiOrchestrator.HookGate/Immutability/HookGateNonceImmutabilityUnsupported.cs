// <copyright file="HookGateNonceImmutabilityUnsupported.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate.Immutability;

/// <summary>
/// Event emitted when best-effort immutability cannot be applied at the redirection target
/// (HK-GATE-LINK-2 v1.4). Consumers may use it to surface a user-visible warning.
/// </summary>
public sealed class HookGateNonceImmutabilityUnsupported
{
    /// <summary>Gets the path for which immutability was attempted.</summary>
    public required AbsolutePath Path { get; init; }

    /// <summary>Gets the mechanism attempted (e.g., <c>chattr+i</c>, <c>chflags uchg</c>, <c>DACL-deny</c>, <c>symlink</c>).</summary>
    public required string Mechanism { get; init; }

    /// <summary>Gets the short human-readable reason for the no-op.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the UTC time at which the attempt was made.</summary>
    public required DateTimeOffset At { get; init; }
}
