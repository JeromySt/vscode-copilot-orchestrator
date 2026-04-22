// <copyright file="IHookGateClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.HookGate;

/// <summary>
/// Client for the hook gate authorization daemon. Callers consult the gate before
/// performing potentially-sensitive actions and honour the returned <see cref="HookDecision"/>.
/// </summary>
public interface IHookGateClient
{
    /// <summary>Requests an authorization decision for the given context.</summary>
    /// <param name="ctx">The context describing the action being gated.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The gate's decision for the requested action.</returns>
    ValueTask<HookDecision> RequestAsync(HookContext ctx, CancellationToken ct);
}
