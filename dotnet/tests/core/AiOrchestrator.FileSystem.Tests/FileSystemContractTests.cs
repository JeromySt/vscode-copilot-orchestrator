// <copyright file="FileSystemContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>
/// Reusable contract suite that any <see cref="IFileSystem"/> implementation must satisfy.
/// Job 003 (TestKit) will reuse this class to verify the in-memory implementation.
/// </summary>
public abstract class FileSystemContractTests
{
    /// <summary>Creates an instance of the <see cref="IFileSystem"/> implementation under test plus its scratch root.</summary>
    /// <returns>A tuple of (filesystem, scratch root, dispose action).</returns>
    protected abstract (IFileSystem Fs, AbsolutePath Root, Action Cleanup) CreateFixture();

    [Fact]
    public async Task RoundTrip_Write_Read_Returns_Same_Content()
    {
        var (fs, root, cleanup) = this.CreateFixture();
        try
        {
            var target = root.Combine(new RelativePath("hello.txt"));
            await fs.WriteAllTextAsync(target, "hello world", default);
            var roundTrip = await fs.ReadAllTextAsync(target, default);
            Assert.Equal("hello world", roundTrip);
        }
        finally
        {
            cleanup();
        }
    }

    [Fact]
    public async Task ExistsAsync_Returns_False_For_Missing()
    {
        var (fs, root, cleanup) = this.CreateFixture();
        try
        {
            var missing = root.Combine(new RelativePath("does-not-exist"));
            var exists = await fs.ExistsAsync(missing, default);
            Assert.False(exists);
        }
        finally
        {
            cleanup();
        }
    }

    [Fact]
    public async Task DeleteAsync_Removes_File()
    {
        var (fs, root, cleanup) = this.CreateFixture();
        try
        {
            var target = root.Combine(new RelativePath("delete-me.txt"));
            await fs.WriteAllTextAsync(target, "x", default);
            Assert.True(await fs.ExistsAsync(target, default));
            await fs.DeleteAsync(target, default);
            Assert.False(await fs.ExistsAsync(target, default));
        }
        finally
        {
            cleanup();
        }
    }
}
