// <copyright file="BackpressureMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Eventing;

/// <summary>Specifies how the bus handles writes to a full per-subscription channel.</summary>
public enum BackpressureMode
{
    /// <summary>Block the publisher until space is available.</summary>
    Wait,

    /// <summary>Discard the oldest queued event to make room for the new event.</summary>
    DropOldest,

    /// <summary>Discard the new event without blocking the publisher.</summary>
    DropNewest,

    /// <summary>Throw <see cref="EventBusFullException"/> on the publisher thread.</summary>
    Throw,
}
