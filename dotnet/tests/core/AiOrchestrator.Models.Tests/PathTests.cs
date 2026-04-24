// <copyright file="PathTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Models.Tests;

public sealed class AbsolutePathTests
{
    [Fact]
    public void Construction_ValidRootedPath_Succeeds()
    {
        var path = new AbsolutePath("/usr/bin");

        Assert.Equal("/usr/bin", path.Value);
    }

    [Fact]
    public void Construction_WindowsPath_Succeeds()
    {
        var path = new AbsolutePath(@"C:\Users\test");

        Assert.Equal(@"C:\Users\test", path.Value);
    }

    [Fact]
    public void Construction_Null_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new AbsolutePath(null!));
    }

    [Fact]
    public void Construction_Empty_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new AbsolutePath(string.Empty));
    }

    [Fact]
    public void Construction_RelativePath_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new AbsolutePath("relative/path"));
    }

    [Fact]
    public void Combine_AppendsRelativePath()
    {
        var abs = new AbsolutePath("/repo");
        var rel = new RelativePath("src/main.cs");

        var combined = abs.Combine(rel);

        Assert.Contains("src", combined.Value);
        Assert.Contains("main.cs", combined.Value);
    }

    [Fact]
    public void ToString_ReturnsValue()
    {
        var path = new AbsolutePath("/repo");

        Assert.Equal("/repo", path.ToString());
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var a = new AbsolutePath("/repo");
        var b = new AbsolutePath("/repo");

        Assert.Equal(a, b);
    }
}

public sealed class RelativePathTests
{
    [Fact]
    public void Construction_ValidRelativePath_Succeeds()
    {
        var path = new RelativePath("src/main.cs");

        Assert.Equal("src/main.cs", path.Value);
    }

    [Fact]
    public void Construction_Null_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RelativePath(null!));
    }

    [Fact]
    public void Construction_Empty_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RelativePath(string.Empty));
    }

    [Fact]
    public void Construction_RootedPath_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RelativePath("/absolute/path"));
    }

    [Fact]
    public void ToString_ReturnsValue()
    {
        var path = new RelativePath("src/file.cs");

        Assert.Equal("src/file.cs", path.ToString());
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var a = new RelativePath("src/main.cs");
        var b = new RelativePath("src/main.cs");

        Assert.Equal(a, b);
    }
}

public sealed class RepoRelativePathTests
{
    [Fact]
    public void Construction_ValidPath_Succeeds()
    {
        var path = new RepoRelativePath("src/main.cs");

        Assert.Equal("src/main.cs", path.Value);
    }

    [Fact]
    public void Construction_Null_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath(null!));
    }

    [Fact]
    public void Construction_Empty_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath(string.Empty));
    }

    [Fact]
    public void Construction_RootedPath_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath("/absolute/path"));
    }

    [Fact]
    public void Construction_DotDotSegment_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath("src/../etc/passwd"));
    }

    [Fact]
    public void Construction_DotDotOnly_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath(".."));
    }

    [Fact]
    public void Construction_BackslashDotDot_ThrowsArgument()
    {
        Assert.Throws<ArgumentException>(() => new RepoRelativePath(@"src\..\etc"));
    }

    [Fact]
    public void ToString_ReturnsValue()
    {
        var path = new RepoRelativePath("src/file.cs");

        Assert.Equal("src/file.cs", path.ToString());
    }

    [Fact]
    public void Equality_SameValue_AreEqual()
    {
        var a = new RepoRelativePath("src/main.cs");
        var b = new RepoRelativePath("src/main.cs");

        Assert.Equal(a, b);
    }
}
