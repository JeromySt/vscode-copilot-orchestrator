// <copyright file="FakeProcessLifecycle.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;
using AiOrchestrator.Process.Lifecycle;

namespace AiOrchestrator.Process.Tests;

/// <summary>
/// In-memory implementation of <see cref="IProcessLifecycle"/> that records
/// which PIDs had crash dumps captured during a test.
/// </summary>
internal sealed class FakeProcessLifecycle : IProcessLifecycle
{
    private readonly List<(int Pid, AbsolutePath Path)> _captures = [];

    /// <summary>Gets all crash dump capture requests recorded during the test.</summary>
    public IReadOnlyList<(int Pid, AbsolutePath Path)> Captures => _captures;

    /// <inheritdoc/>
    public ValueTask CaptureCrashDumpAsync(int pid, AbsolutePath outputPath, CancellationToken ct)
    {
        _captures.Add((pid, outputPath));
        return ValueTask.CompletedTask;
    }
}
