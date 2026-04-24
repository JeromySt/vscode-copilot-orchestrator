// <copyright file="EnvScopeTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using Xunit;

namespace AiOrchestrator.Process.Tests;

/// <summary>Unit tests for <see cref="EnvScope"/> construction and factory methods.</summary>
public sealed class EnvScopeTests
{
    [Fact]
    public void Restricted_SetsInheritOtherToFalse()
    {
        var vars = ImmutableDictionary<string, string>.Empty.Add("PATH", "/usr/bin");
        var scope = EnvScope.Restricted(vars);

        Assert.False(scope.InheritOther);
        Assert.Equal("/usr/bin", scope.Allowed["PATH"]);
    }

    [Fact]
    public void Inherited_SetsInheritOtherToTrue()
    {
        var additions = ImmutableDictionary<string, string>.Empty.Add("FOO", "bar");
        var scope = EnvScope.Inherited(additions);

        Assert.True(scope.InheritOther);
        Assert.Equal("bar", scope.Allowed["FOO"]);
    }

    [Fact]
    public void Inherited_WithNull_UsesEmptyDictionary()
    {
        var scope = EnvScope.Inherited();

        Assert.True(scope.InheritOther);
        Assert.Empty(scope.Allowed);
    }

    [Fact]
    public void Default_InheritOther_IsFalse()
    {
        var scope = new EnvScope { Allowed = ImmutableDictionary<string, string>.Empty };

        Assert.False(scope.InheritOther);
    }

    [Fact]
    public void RecordEquality_Works()
    {
        var vars = ImmutableDictionary<string, string>.Empty.Add("A", "1");
        var a = EnvScope.Restricted(vars);
        var b = EnvScope.Restricted(vars);

        Assert.Equal(a, b);
    }

    [Fact]
    public void RecordWith_CreatesModifiedCopy()
    {
        var scope = EnvScope.Restricted(ImmutableDictionary<string, string>.Empty);
        var modified = scope with { InheritOther = true };

        Assert.True(modified.InheritOther);
        Assert.False(scope.InheritOther);
    }
}
