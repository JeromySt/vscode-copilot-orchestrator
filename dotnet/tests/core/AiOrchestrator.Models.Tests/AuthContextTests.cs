// <copyright file="AuthContextTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class AuthContextTests
{
    [Fact]
    public void Construction_WithAllRequiredProperties()
    {
        var now = DateTimeOffset.UtcNow;
        var ctx = new AuthContext
        {
            PrincipalId = "user-42",
            DisplayName = "Alice",
            Scopes = ImmutableArray.Create("read", "write"),
            IssuedAtUtc = now,
            ExpiresAtUtc = now.AddHours(1),
        };

        Assert.Equal("user-42", ctx.PrincipalId);
        Assert.Equal("Alice", ctx.DisplayName);
        Assert.Equal(2, ctx.Scopes.Length);
        Assert.Equal(now, ctx.IssuedAtUtc);
        Assert.Equal(now.AddHours(1), ctx.ExpiresAtUtc);
    }

    [Fact]
    public void ExpiresAtUtc_DefaultsToNull()
    {
        var ctx = new AuthContext
        {
            PrincipalId = "user-1",
            DisplayName = "Bob",
            Scopes = ImmutableArray<string>.Empty,
        };

        Assert.Null(ctx.ExpiresAtUtc);
    }

    [Fact]
    public void Record_Equality_Works()
    {
        var scopes = ImmutableArray.Create("read");
        var a = new AuthContext { PrincipalId = "u1", DisplayName = "A", Scopes = scopes };
        var b = new AuthContext { PrincipalId = "u1", DisplayName = "A", Scopes = scopes };

        Assert.Equal(a, b);
    }
}
