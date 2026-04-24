// <copyright file="EventVAttributeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Eventing;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class EventVAttributeTests
{
    [Fact]
    public void Construction_SetsProperties()
    {
        var attr = new EventVAttribute("plan.created", 2);

        Assert.Equal("plan.created", attr.EventTypeName);
        Assert.Equal(2, attr.Version);
    }

    [Fact]
    public void Construction_NullEventTypeName_ThrowsArgumentNull()
    {
        Assert.Throws<ArgumentNullException>(() => new EventVAttribute(null!, 1));
    }
}
