// <copyright file="EventFilterTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

public sealed class EventFilterTests
{
    private static AuthContext MakeAuth() => new AuthContext
    {
        PrincipalId = "user-1",
        DisplayName = "Test User",
        Scopes = ImmutableArray.Create("read", "write"),
    };

    [Fact]
    public void Construction_WithAllProperties()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();
        var filter = new EventFilter
        {
            SubscribingPrincipal = MakeAuth(),
            PlanId = planId,
            JobId = jobId,
            Predicate = _ => true,
        };

        Assert.Equal(planId, filter.PlanId);
        Assert.Equal(jobId, filter.JobId);
        Assert.NotNull(filter.Predicate);
        Assert.Equal("user-1", filter.SubscribingPrincipal.PrincipalId);
    }

    [Fact]
    public void Construction_OptionalProperties_DefaultToNull()
    {
        var filter = new EventFilter
        {
            SubscribingPrincipal = MakeAuth(),
        };

        Assert.Null(filter.PlanId);
        Assert.Null(filter.JobId);
        Assert.Null(filter.Predicate);
    }
}
