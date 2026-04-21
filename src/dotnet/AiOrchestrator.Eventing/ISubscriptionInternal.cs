// <copyright file="ISubscriptionInternal.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Eventing;

/// <summary>
/// Internal contract implemented by every typed subscription so the bus can iterate
/// subscriptions of mixed event types from a single dictionary.
/// </summary>
internal interface ISubscriptionInternal : IAsyncDisposable
{
    /// <summary>Gets the unique identifier for this subscription.</summary>
    Guid Id { get; }

    /// <summary>Gets the runtime type of events the subscription accepts.</summary>
    Type EventType { get; }
}
