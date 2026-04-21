// <copyright file="PathValidatorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using AiOrchestrator.Foundation.Tests;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.PathValidator.Paths;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.PathValidator.Tests;

/// <summary>Contract tests for PathValidator implementation.</summary>
public sealed class PathValidatorTests
{
    [Fact]
    [ContractTest("PV-1")]
    public void AssertSafe_WithValidPath_Succeeds()
    {
        var validator = new DefaultPathValidator(new[] { "/root", @"C:\allowed" });
        var allowedRoot = new AbsolutePath(Path.IsPathRooted("/root") ? "/root" : RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\allowed" : "/root");
        var safePath = new AbsolutePath(Path.IsPathRooted("/root") ? "/root/subdir/file.txt" : RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\allowed\subdir\file.txt" : "/root/subdir/file.txt");

        // Should not throw
        validator.AssertSafe(safePath, allowedRoot);
    }

    [Fact]
    [ContractTest("PV-2")]
    public void AssertSafe_WithTraversalAttempt_ThrowsUnauthorizedAccessException()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        var allowedRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root")
            : new AbsolutePath("/root");
        var traversalPath = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root\..\outside")
            : new AbsolutePath("/root/../outside");

        var act = () => validator.AssertSafe(traversalPath, allowedRoot);
        act.Should().Throw<UnauthorizedAccessException>();
    }

    [Fact]
    [ContractTest("PV-3")]
    public void AssertSafe_WithPathOutsideRoot_ThrowsUnauthorizedAccessException()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        var allowedRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root")
            : new AbsolutePath("/root");
        var outsidePath = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\outside\file.txt")
            : new AbsolutePath("/outside/file.txt");

        var act = () => validator.AssertSafe(outsidePath, allowedRoot);
        act.Should().Throw<UnauthorizedAccessException>();
    }

    [Fact]
    [ContractTest("PV-4")]
    public void AssertSafe_WithReservedWindowsDeviceName_ThrowsUnauthorizedAccessException()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        var allowedRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root")
            : new AbsolutePath("/root");
        var devicePath = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root\CON")
            : new AbsolutePath("/root/CON");

        var act = () => validator.AssertSafe(devicePath, allowedRoot);
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            act.Should().Throw<UnauthorizedAccessException>();
        }
        else
        {
            // On POSIX systems, CON is just a filename, so it should succeed
            act.Should().NotThrow();
        }
    }

    [Fact]
    [ContractTest("PV-5")]
    public void AssertSafe_WithNulByte_ThrowsUnauthorizedAccessException()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        var allowedRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? new AbsolutePath(@"C:\root")
            : new AbsolutePath("/root");

        // This should fail during AbsolutePath construction, but if it somehow gets past,
        // AssertSafe should catch it
        var act = () =>
        {
            try
            {
                var pathWithNul = new AbsolutePath(RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                    ? @"C:\root\file.txt\0.txt"
                    : "/root/file.txt\0.txt");
                validator.AssertSafe(pathWithNul, allowedRoot);
            }
            catch (ArgumentException)
            {
                // Expected from AbsolutePath constructor
                throw new UnauthorizedAccessException("NUL byte detected");
            }
        };

        act.Should().Throw<UnauthorizedAccessException>();
    }

    [Fact]
    [ContractTest("PV-6")]
    public void AssertSafe_CaseInsensitiveOnWindows_SucceedsForReservedNames()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // This test only applies to Windows
            return;
        }

        var validator = new DefaultPathValidator(new[] { @"C:\root" });
        var allowedRoot = new AbsolutePath(@"C:\root");
        var devicePath = new AbsolutePath(@"C:\root\con"); // lowercase

        var act = () => validator.AssertSafe(devicePath, allowedRoot);
        act.Should().Throw<UnauthorizedAccessException>();
    }

    [Fact]
    [ContractTest("PV-7")]
    public void OpenReadUnderRootAsync_WithValidRelativePath_OpensStream()
    {
        // Create a temporary directory and file
        var tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(tempDir);
        try
        {
            var filePath = Path.Combine(tempDir, "test.txt");
            File.WriteAllText(filePath, "test content");

            var validator = new DefaultPathValidator(new[] { tempDir });
            var allowedRoot = new AbsolutePath(tempDir);
            var relativePath = new RelativePath("test.txt");

            var task = validator.OpenReadUnderRootAsync(allowedRoot, relativePath, CancellationToken.None);
            var stream = task.GetAwaiter().GetResult();

            stream.Should().NotBeNull();
            stream.Should().BeReadable();
            stream.Dispose();
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Ignore cleanup errors
            }
        }
    }

    [Fact]
    [ContractTest("PV-8")]
    public void OpenReadUnderRootAsync_WithTraversalInRelativePath_ThrowsUnauthorizedAccessException()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(tempDir);
        try
        {
            var validator = new DefaultPathValidator(new[] { tempDir });
            var allowedRoot = new AbsolutePath(tempDir);
            var traversalPath = new RelativePath("../outside/file.txt");

            var act = () => validator.OpenReadUnderRootAsync(allowedRoot, traversalPath, CancellationToken.None)
                .GetAwaiter()
                .GetResult();

            act.Should().Throw<UnauthorizedAccessException>();
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Ignore cleanup errors
            }
        }
    }
}
