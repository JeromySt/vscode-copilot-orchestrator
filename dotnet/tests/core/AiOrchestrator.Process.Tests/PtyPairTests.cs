// <copyright file="PtyPairTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Process.Pty;
using Microsoft.Win32.SafeHandles;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Unit tests for <see cref="PtyPair"/> construction, disposal, and idempotency.</summary>
public sealed class PtyPairTests
{
    [Fact]
    public void Constructor_SetsProperties()
    {
        using var master = new FakeSafeHandle();
        using var slave = new FakeSafeHandle();

        using var pair = new PtyPair(master, slave);

        Assert.Same(master, pair.Master);
        Assert.Same(slave, pair.Slave);
    }

    [Fact]
    public void Dispose_IsIdempotent()
    {
        using var master = new FakeSafeHandle();
        using var slave = new FakeSafeHandle();

        var pair = new PtyPair(master, slave);

        pair.Dispose();
        pair.Dispose();
        pair.Dispose();

        // No exception = pass (idempotent)
    }

    [Fact]
    public void RecordEquality_SameHandles()
    {
        using var master = new FakeSafeHandle();
        using var slave = new FakeSafeHandle();

        var a = new PtyPair(master, slave);
        var b = new PtyPair(master, slave);

        // Record equality compares the handles by reference
        Assert.Equal(a, b);
    }

    /// <summary>Minimal safe handle for testing.</summary>
    private sealed class FakeSafeHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public FakeSafeHandle()
            : base(ownsHandle: true)
        {
            this.SetHandle(nint.Zero + 1); // Non-zero so not "invalid"
        }

        protected override bool ReleaseHandle() => true;
    }
}
