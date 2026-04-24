// <copyright file="ProtectedStringTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Abstractions.Credentials;
using Xunit;

namespace AiOrchestrator.Abstractions.Tests;

public sealed class ProtectedStringTests
{
    [Fact]
    public void Reveal_ReturnsOriginalSecret()
    {
        using var ps = new ProtectedString("my-secret-token");

        Assert.Equal("my-secret-token", ps.Reveal());
    }

    [Fact]
    public void Length_ReturnsUtf8ByteCount()
    {
        using var ps = new ProtectedString("abc");

        Assert.Equal(3, ps.Length);
    }

    [Fact]
    public void CopyTo_CopiesBytesToSpan()
    {
        using var ps = new ProtectedString("hello");
        var buf = new byte[16];

        int written = ps.CopyTo(buf);

        Assert.Equal(5, written);
        Assert.Equal("hello", System.Text.Encoding.UTF8.GetString(buf, 0, written));
    }

    [Fact]
    public void Dispose_ZerosBuffer_And_RevealThrows()
    {
        var ps = new ProtectedString("secret");

        ps.Dispose();

        Assert.True(ps.IsDisposed);
        Assert.Equal(0, ps.Length);
        Assert.Throws<ObjectDisposedException>(() => ps.Reveal());
    }

    [Fact]
    public void Dispose_DoubleDispose_IsIdempotent()
    {
        var ps = new ProtectedString("secret");

        ps.Dispose();
        ps.Dispose(); // should not throw

        Assert.True(ps.IsDisposed);
    }

    [Fact]
    public void CopyTo_AfterDispose_Throws()
    {
        var ps = new ProtectedString("secret");
        ps.Dispose();

        Assert.Throws<ObjectDisposedException>(() => ps.CopyTo(new byte[16]));
    }

    [Fact]
    public void ToString_AlwaysReturnsRedacted()
    {
        using var ps = new ProtectedString("super-secret");

        Assert.Equal("***", ps.ToString());
    }

    [Fact]
    public void Constructor_FromBytes_CopiesBuffer()
    {
        byte[] original = System.Text.Encoding.UTF8.GetBytes("byte-secret");
        using var ps = new ProtectedString(original);

        Assert.Equal("byte-secret", ps.Reveal());
        Assert.Equal(original.Length, ps.Length);
    }

    [Fact]
    public void Constructor_NullString_ThrowsArgumentNull()
    {
        Assert.Throws<ArgumentNullException>(() => new ProtectedString((string)null!));
    }
}
