// <copyright file="EventBusSubscriptionLagged.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Eventing;

/// <summary>
/// Emitted by <see cref="EventBus"/> when a subscription's bounded channel cannot accept a new event
/// and the configured <see cref="BackpressureMode"/> resulted in one or more dropped events.
/// </summary>
/// <param name="SubscriptionId">The unique identifier of the lagging subscription.</param>
/// <param name="DroppedCount">The cumulative count of events dropped on this subscription.</param>
/// <param name="Mode">The <see cref="BackpressureMode"/> active when the drop occurred.</param>
public sealed record EventBusSubscriptionLagged(Guid SubscriptionId, int DroppedCount, BackpressureMode Mode);
