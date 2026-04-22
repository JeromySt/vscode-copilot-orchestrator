// <copyright file="IImmutabilityEventSink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate.Immutability;

/// <summary>
/// Abstraction over <see cref="Abstractions.Eventing.IEventBus"/> for publishing
/// <see cref="HookGateNonceImmutabilityUnsupported"/> events. Allows daemon components to
/// emit these without taking a direct IEventBus dependency (supports test doubles).
/// </summary>
public interface IImmutabilityEventSink
{
    /// <summary>Publishes an immutability-unsupported event.</summary>
    /// <param name="evt">The event to publish.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when all subscribers have been notified.</returns>
    ValueTask PublishAsync(HookGateNonceImmutabilityUnsupported evt, CancellationToken ct);
}
