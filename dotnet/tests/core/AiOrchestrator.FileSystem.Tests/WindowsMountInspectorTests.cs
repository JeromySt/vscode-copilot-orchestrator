// <copyright file="WindowsMountInspectorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem.Native.Windows;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Unit tests for <see cref="WindowsMountInspector.Classify"/> pure logic (no P/Invoke).</summary>
public sealed class WindowsMountInspectorTests
{
    [Theory]
    [InlineData(@"\\server\share\file.txt", MountKind.Smb)]
    [InlineData(@"\\192.168.1.1\data", MountKind.Smb)]
    [InlineData("//server/share/file.txt", MountKind.Smb)]
    public void Classify_UncPaths_ReturnSmb(string path, MountKind expected)
    {
        Assert.Equal(expected, WindowsMountInspector.Classify(path));
    }

    [Theory]
    [InlineData("X", MountKind.Unknown)]
    [InlineData("", MountKind.Unknown)]
    [InlineData("a", MountKind.Unknown)]
    public void Classify_ShortOrNoDriveLetter_ReturnsUnknown(string path, MountKind expected)
    {
        Assert.Equal(expected, WindowsMountInspector.Classify(path));
    }

    [Fact]
    public void Classify_NullPath_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => WindowsMountInspector.Classify(null!));
    }

    [Fact]
    public void Classify_LocalDriveLetter_ReturnsLocalOrUnknown()
    {
        // C:\ on Windows should return Local; on non-Windows it may return Unknown
        // since GetDriveType P/Invoke may not be available.
        var result = WindowsMountInspector.Classify(@"C:\Users\test");
        Assert.True(result == MountKind.Local || result == MountKind.Unknown,
            $"Expected Local or Unknown, got {result}");
    }
}
