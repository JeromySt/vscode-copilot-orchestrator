// <copyright file="EventVAttribute.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Models.Eventing;

/// <summary>
/// Marks a type as a versioned domain event payload that participates in the
/// event-version migration graph (rules EV-GEN-1..3).
/// </summary>
/// <remarks>
/// Every <c>[EventV(name, version)]</c>-attributed type is enrolled in the
/// generated <c>EventTypeRegistry</c> and required to have a public
/// <see cref="IEventMigration{TFrom,TTo}"/> implementation for every adjacent
/// version pair. Missing migrations cause the build to fail with diagnostic
/// <c>EVGEN001</c>.
/// </remarks>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, AllowMultiple = false)]
public sealed class EventVAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="EventVAttribute"/> class.</summary>
    /// <param name="eventTypeName">Stable wire-format discriminator string.</param>
    /// <param name="version">1-based monotonically increasing version number.</param>
    public EventVAttribute(string eventTypeName, int version)
    {
        this.EventTypeName = eventTypeName ?? throw new ArgumentNullException(nameof(eventTypeName));
        this.Version = version;
    }

    /// <summary>Gets the stable wire-format discriminator string.</summary>
    public string EventTypeName { get; }

    /// <summary>Gets the 1-based monotonically increasing version number.</summary>
    public int Version { get; }
}
