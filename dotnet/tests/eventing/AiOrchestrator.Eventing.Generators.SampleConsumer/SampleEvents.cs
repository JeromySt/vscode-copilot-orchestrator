// <copyright file="SampleEvents.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.Eventing.Generators.SampleConsumer;

[EventV("Demo.Order", 1)]
public sealed record OrderV1(string Id);

[EventV("Demo.Order", 2)]
public sealed record OrderV2(string Id, string Currency);

public sealed class OrderMigration1To2 : IEventMigration<OrderV1, OrderV2>
{
    public OrderV2 Migrate(OrderV1 from) => new(from.Id, "USD");
}
