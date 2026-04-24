// <copyright file="EventEnvelopeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Text.Json;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Ids;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class EventEnvelopeTests
{
    [Fact]
    public void Construction_WithAllRequiredProperties()
    {
        var eventId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var payload = JsonDocument.Parse("{\"key\":\"value\"}").RootElement;

        var envelope = new EventEnvelope
        {
            EventId = eventId,
            RecordSeq = 42,
            OccurredAtUtc = now,
            EventType = "plan.created",
            SchemaVersion = 1,
            Payload = payload,
        };

        Assert.Equal(eventId, envelope.EventId);
        Assert.Equal(42, envelope.RecordSeq);
        Assert.Equal(now, envelope.OccurredAtUtc);
        Assert.Equal("plan.created", envelope.EventType);
        Assert.Equal(1, envelope.SchemaVersion);
    }

    [Fact]
    public void Construction_OptionalProperties_DefaultToNull()
    {
        var envelope = new EventEnvelope
        {
            EventId = Guid.NewGuid(),
            RecordSeq = 1,
            OccurredAtUtc = DateTimeOffset.UtcNow,
            EventType = "test.event",
            SchemaVersion = 1,
            Payload = JsonDocument.Parse("{}").RootElement,
        };

        Assert.Null(envelope.PlanId);
        Assert.Null(envelope.JobId);
        Assert.Null(envelope.PrincipalId);
    }

    [Fact]
    public void Construction_WithOptionalIds()
    {
        var planId = PlanId.New();
        var jobId = JobId.New();

        var envelope = new EventEnvelope
        {
            EventId = Guid.NewGuid(),
            RecordSeq = 1,
            OccurredAtUtc = DateTimeOffset.UtcNow,
            EventType = "job.started",
            SchemaVersion = 1,
            Payload = JsonDocument.Parse("{}").RootElement,
            PlanId = planId,
            JobId = jobId,
            PrincipalId = "user-1",
        };

        Assert.Equal(planId, envelope.PlanId);
        Assert.Equal(jobId, envelope.JobId);
        Assert.Equal("user-1", envelope.PrincipalId);
    }
}
