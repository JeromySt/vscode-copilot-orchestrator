// <copyright file="DefaultExecutableLocator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;

namespace AiOrchestrator.Agent;

/// <summary>Default <see cref="IExecutableLocator"/> walking the <c>PATH</c> environment variable.</summary>
public sealed class DefaultExecutableLocator : IExecutableLocator
{
    private static readonly string[] WindowsExtensions = [".exe", ".cmd", ".bat", ".com"];

    /// <inheritdoc/>
    public string? Locate(string executableName)
    {
        ArgumentException.ThrowIfNullOrEmpty(executableName);

        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        var isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        var separator = isWindows ? ';' : ':';
        var extensions = isWindows ? WindowsExtensions : [string.Empty];

        foreach (var dir in path.Split(separator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var ext in extensions)
            {
                var candidate = Path.Combine(dir, executableName + ext);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}
