// <copyright file="CredentialTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Abstractions.Credentials;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

public sealed class CredentialTests
{
    private static Credential CreateCredential(string secret = "token-123") =>
        new Credential
        {
            Username = "user@example.com",
            Password = new ProtectedString(secret),
            RetrievedAt = DateTimeOffset.UtcNow,
            SourceProtocol = "https",
        };

    [Fact]
    public void Construction_SetsAllProperties()
    {
        var now = DateTimeOffset.UtcNow;
        using var cred = new Credential
        {
            Username = "alice",
            Password = new ProtectedString("pass"),
            RetrievedAt = now,
            SourceProtocol = "ssh",
        };

        Assert.Equal("alice", cred.Username);
        Assert.Equal("pass", cred.Password.Reveal());
        Assert.Equal(now, cred.RetrievedAt);
        Assert.Equal("ssh", cred.SourceProtocol);
    }

    [Fact]
    public void Dispose_ZerosPassword()
    {
        var cred = CreateCredential();

        cred.Dispose();

        Assert.True(cred.Password.IsDisposed);
    }

    [Fact]
    public void Dispose_DoubleDispose_IsIdempotent()
    {
        var cred = CreateCredential();

        cred.Dispose();
        cred.Dispose(); // should not throw
    }

    [Fact]
    public void ThrowIfDisposed_BeforeDispose_DoesNotThrow()
    {
        using var cred = CreateCredential();

        cred.ThrowIfDisposed(); // should not throw
    }

    [Fact]
    public void ThrowIfDisposed_AfterDispose_Throws()
    {
        var cred = CreateCredential();
        cred.Dispose();

        Assert.Throws<ObjectDisposedException>(() => cred.ThrowIfDisposed());
    }
}
