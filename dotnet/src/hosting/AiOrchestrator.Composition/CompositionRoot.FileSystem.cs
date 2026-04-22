// <copyright file="CompositionRoot.FileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.FileSystem.Native.Linux;
using AiOrchestrator.FileSystem.Native.Windows;
using AiOrchestrator.FileSystem.Watching;
using Microsoft.Extensions.DependencyInjection;

namespace AiOrchestrator.Composition;

/// <summary>Composition root extensions for the FileSystem subsystem (job 009).</summary>
public static partial class CompositionRoot
{
    /// <summary>Registers <see cref="IFileSystem"/> and an OS-appropriate <see cref="IMountInspector"/>.</summary>
    /// <param name="services">The DI service collection.</param>
    /// <returns>The same <paramref name="services"/> for chaining.</returns>
    public static IServiceCollection AddFileSystem(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            _ = services.AddSingleton<IMountInspector, WindowsMountInspector>();
        }
        else
        {
            _ = services.AddSingleton<IMountInspector, LinuxMountInspector>();
        }

        _ = services.AddSingleton<IFileSystem, AsyncFileSystem>();

        // DebouncedFileWatcher is constructed per-watch-target by callers; we expose it as
        // IFileWatcher via a transient registration so it appears in the composition root.
        _ = services.AddTransient<IFileWatcher, DebouncedFileWatcher>();
        return services;
    }
}
