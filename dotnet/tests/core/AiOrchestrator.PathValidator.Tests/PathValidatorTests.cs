// <copyright file="PathValidatorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using AiOrchestrator.Foundation.Tests;
using AiOrchestrator.PathValidator.Paths;
using Xunit;

namespace AiOrchestrator.PathValidator.Tests;

/// <summary>Contract tests for PathValidator implementation.</summary>
public sealed class PathValidatorTests
{
    [Fact]
    [ContractTest("PV-1")]
    public void DefaultPathValidator_CreatesInstance_WithAllowedRoots()
    {
        var roots = new[] { "/root", @"C:\allowed" };
        var validator = new DefaultPathValidator(roots);

        Assert.NotNull(validator);
    }

    [Fact]
    [ContractTest("PV-2")]
    public void DefaultPathValidator_RejectsTraversal_InPath()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        
        // Path with traversal should fail validation
        var act = () => validator.AssertSafe("/root/../outside/file.txt", "/root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    [Fact]
    [ContractTest("PV-3")]
    public void DefaultPathValidator_RejectsPathOutsideRoot_()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        
        // Path outside root should fail
        var act = () => validator.AssertSafe("/outside/file.txt", "/root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    [Fact]
    [ContractTest("PV-4")]
    public void DefaultPathValidator_RejectsReservedNames_OnWindows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // Only test on Windows
        }

        var validator = new DefaultPathValidator(new[] { @"C:\root" });
        
        // CON is a reserved device name on Windows
        var act = () => validator.AssertSafe(@"C:\root\CON", @"C:\root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    [Fact]
    [ContractTest("PV-5")]
    public void DefaultPathValidator_AcceptsValidPath_UnderRoot()
    {
        var root = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? @"C:\root" : "/root";
        var validator = new DefaultPathValidator(new[] { root });
        
        var safePath = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? @"C:\root\subdir\file.txt"
            : "/root/subdir/file.txt";

        // Should not throw
        validator.AssertSafe(safePath, root);
    }

    [Fact]
    [ContractTest("PV-6")]
    public void DefaultPathValidator_RejectsNonFullyQualifiedPath()
    {
        var validator = new DefaultPathValidator(new[] { "/root" });
        
        // Relative path should fail
        var act = () => validator.AssertSafe("relative/path", "/root");
        Assert.Throws<UnauthorizedAccessException>(act);
    }

    [Fact]
    [ContractTest("PV-7")]
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_WithValidFile_ReturnsStream()
    {
        // Create a temporary directory and file
        var tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(tempDir);
        try
        {
            var filePath = Path.Combine(tempDir, "test.txt");
            File.WriteAllText(filePath, "test content");

            var validator = new DefaultPathValidator(new[] { tempDir });
            var stream = await validator.OpenReadUnderRootAsync(tempDir, "test.txt", CancellationToken.None);

            Assert.NotNull(stream);
            Assert.True(stream.CanRead);
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
    public async System.Threading.Tasks.Task OpenReadUnderRootAsync_WithTraversalInRelativePath_Throws()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(tempDir);
        try
        {
            var validator = new DefaultPathValidator(new[] { tempDir });

            var act = async () =>
            {
                await validator.OpenReadUnderRootAsync(tempDir, "../outside/file.txt", CancellationToken.None);
            };

            await Assert.ThrowsAsync<UnauthorizedAccessException>(act);
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
