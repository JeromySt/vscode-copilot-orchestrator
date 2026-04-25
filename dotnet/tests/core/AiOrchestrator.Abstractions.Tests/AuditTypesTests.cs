// <copyright file="AuditTypesTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Abstractions.Audit;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

/// <summary>Unit tests for Audit record types: AuditEvent, AuditChainResult, AuditVerifyOptions, AuditOutcome.</summary>
public sealed class AuditTypesTests
{
    // ---- AuditEvent ----

    [Fact]
    public void AuditEvent_Ctor_SetsAllProperties()
    {
        var id = Guid.NewGuid();
        var at = DateTimeOffset.UtcNow;
        var evt = new AuditEvent(id, at, "user:alice", "plan.created", "plan-1", AuditOutcome.Success, "{}", "abc123");

        Assert.Equal(id, evt.EventId);
        Assert.Equal(at, evt.OccurredAtUtc);
        Assert.Equal("user:alice", evt.PrincipalId);
        Assert.Equal("plan.created", evt.Action);
        Assert.Equal("plan-1", evt.ResourceId);
        Assert.Equal(AuditOutcome.Success, evt.Outcome);
        Assert.Equal("{}", evt.Details);
        Assert.Equal("abc123", evt.ChainHash);
    }

    [Fact]
    public void AuditEvent_NullableFieldsCanBeNull()
    {
        var evt = new AuditEvent(Guid.NewGuid(), DateTimeOffset.UtcNow, "sys", "action", null, AuditOutcome.Failure, null, null);

        Assert.Null(evt.ResourceId);
        Assert.Null(evt.Details);
        Assert.Null(evt.ChainHash);
    }

    [Fact]
    public void AuditEvent_RecordEquality()
    {
        var id = Guid.NewGuid();
        var at = DateTimeOffset.UtcNow;
        var a = new AuditEvent(id, at, "u", "a", "r", AuditOutcome.Success, "d", "h");
        var b = new AuditEvent(id, at, "u", "a", "r", AuditOutcome.Success, "d", "h");

        Assert.Equal(a, b);
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
    }

    [Fact]
    public void AuditEvent_With_CreatesModifiedCopy()
    {
        var evt = new AuditEvent(Guid.NewGuid(), DateTimeOffset.UtcNow, "u", "a", "r", AuditOutcome.Success, null, null);
        var modified = evt with { Outcome = AuditOutcome.Denied };

        Assert.Equal(AuditOutcome.Denied, modified.Outcome);
        Assert.Equal(evt.EventId, modified.EventId);
    }

    // ---- AuditChainResult ----

    [Fact]
    public void AuditChainResult_ValidChain_Properties()
    {
        var result = new AuditChainResult(true, 100, null, null);

        Assert.True(result.IsValid);
        Assert.Equal(100, result.EventsVerified);
        Assert.Null(result.FirstBrokenSequence);
        Assert.Null(result.ErrorMessage);
    }

    [Fact]
    public void AuditChainResult_BrokenChain_Properties()
    {
        var result = new AuditChainResult(false, 50, 42, "Hash mismatch at sequence 42");

        Assert.False(result.IsValid);
        Assert.Equal(50, result.EventsVerified);
        Assert.Equal(42, result.FirstBrokenSequence);
        Assert.Contains("42", result.ErrorMessage);
    }

    [Fact]
    public void AuditChainResult_RecordEquality()
    {
        var a = new AuditChainResult(true, 10, null, null);
        var b = new AuditChainResult(true, 10, null, null);

        Assert.Equal(a, b);
    }

    // ---- AuditVerifyOptions ----

    [Fact]
    public void AuditVerifyOptions_Ctor_SetsProperties()
    {
        var opts = new AuditVerifyOptions(10, 200, true);

        Assert.Equal(10, opts.FromSequence);
        Assert.Equal(200, opts.ToSequence);
        Assert.True(opts.StopOnFirstError);
    }

    [Fact]
    public void AuditVerifyOptions_NullRanges()
    {
        var opts = new AuditVerifyOptions(null, null, false);

        Assert.Null(opts.FromSequence);
        Assert.Null(opts.ToSequence);
        Assert.False(opts.StopOnFirstError);
    }

    [Fact]
    public void AuditVerifyOptions_RecordEquality()
    {
        var a = new AuditVerifyOptions(1, 100, true);
        var b = new AuditVerifyOptions(1, 100, true);

        Assert.Equal(a, b);
    }

    [Fact]
    public void AuditVerifyOptions_With_CreatesModifiedCopy()
    {
        var opts = new AuditVerifyOptions(1, 100, true);
        var modified = opts with { StopOnFirstError = false };

        Assert.False(modified.StopOnFirstError);
        Assert.Equal(1, modified.FromSequence);
    }

    // ---- AuditOutcome ----

    [Fact]
    public void AuditOutcome_HasExpectedValues()
    {
        Assert.Equal(0, (int)AuditOutcome.Success);
        Assert.Equal(1, (int)AuditOutcome.Failure);
        Assert.Equal(2, (int)AuditOutcome.Denied);
    }

    [Fact]
    public void AuditOutcome_AllValuesAreDefined()
    {
        var values = Enum.GetValues<AuditOutcome>();
        Assert.Equal(3, values.Length);
    }
}
