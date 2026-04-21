// <copyright file="EventBusFullException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Eventing;

/// <summary>
/// Thrown by <see cref="EventBus.PublishAsync{TEvent}"/> when a subscription's bounded channel
/// is full and the configured <see cref="BackpressureMode"/> is <see cref="BackpressureMode.Throw"/>.
/// </summary>
public sealed class EventBusFullException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="EventBusFullException"/> class.</summary>
    /// <param name="message">A human-readable description of the failure.</param>
    public EventBusFullException(string message)
        : base(message)
    {
    }
}
