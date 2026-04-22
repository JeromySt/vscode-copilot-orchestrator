// <copyright file="CompositionRootTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Composition;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.FileSystem.Watching;
using AiOrchestrator.PathValidator.Paths;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Verifies that <c>CompositionRoot.AddFileSystem</c> wires the public surface.</summary>
public sealed class CompositionRootTests
{
    [Fact]
    public void AddFileSystem_RegistersFileSystemAndMountInspector()
    {
        var services = new ServiceCollection();

        // Register the IPathValidator dependency required by AsyncFileSystem.
        _ = services.AddSingleton<IPathValidator>(_ => new DefaultPathValidator(new[] { "/" }));
        _ = services.AddFileSystem();

        using var provider = services.BuildServiceProvider();

        Assert.NotNull(provider.GetService<IFileSystem>());
        Assert.NotNull(provider.GetService<IMountInspector>());

        // IFileWatcher is transient — resolving requires construction args (root, debounce, clock).
        // We just assert the descriptor is present.
        Assert.Contains(services, d => d.ServiceType == typeof(IFileWatcher));
    }
}
