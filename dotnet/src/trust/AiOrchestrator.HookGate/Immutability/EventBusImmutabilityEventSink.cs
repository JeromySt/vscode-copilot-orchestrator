// <copyright file="EventBusImmutabilityEventSink.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;

namespace AiOrchestrator.HookGate.Immutability;

/// <summary>Default <see cref="IImmutabilityEventSink"/> that forwards to <see cref="IEventBus"/>.</summary>
internal sealed class EventBusImmutabilityEventSink : IImmutabilityEventSink
{
    private readonly IEventBus bus;

    public EventBusImmutabilityEventSink(IEventBus bus)
        => this.bus = bus ?? throw new ArgumentNullException(nameof(bus));

    public ValueTask PublishAsync(HookGateNonceImmutabilityUnsupported evt, CancellationToken ct)
        => this.bus.PublishAsync(evt, ct);
}
