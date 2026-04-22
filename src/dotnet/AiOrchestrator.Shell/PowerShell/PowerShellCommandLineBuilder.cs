// <copyright file="PowerShellCommandLineBuilder.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell.PowerShell;

/// <summary>
/// Builds the hardened argv vector for invoking <c>powershell</c> or <c>pwsh</c> against
/// a script file. Encodes PS-ISO-1 (mandatory <c>-NoProfile -NonInteractive
/// -ExecutionPolicy Bypass -File</c>) and PS-ISO-4 (rejection of <c>-Command</c> /
/// <c>-EncodedCommand</c> at build time).
/// </summary>
internal sealed class PowerShellCommandLineBuilder
{
    private static readonly ImmutableHashSet<string> ForbiddenFlags =
        ImmutableHashSet.Create<string>(
            StringComparer.OrdinalIgnoreCase,
            "-Command",
            "/Command",
            "-c",
            "/c",
            "-EncodedCommand",
            "/EncodedCommand",
            "-e",
            "/e",
            "-ec",
            "/ec");

    /// <summary>
    /// Returns the immutable hardened argv vector for invoking PowerShell against
    /// the given script path (PS-ISO-1).
    /// </summary>
    /// <param name="scriptPath">Absolute path to a <c>.ps1</c> script (PS-ISO-2).</param>
    /// <returns>The argv vector, ready to pass to <c>IProcessSpawner</c>.</returns>
    public ImmutableArray<string> Build(AbsolutePath scriptPath)
    {
        return ImmutableArray.Create(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath.Value);
    }

    /// <summary>
    /// PS-ISO-4: returns <see langword="true"/> if any element of <paramref name="args"/>
    /// matches a forbidden PowerShell flag (<c>-Command</c> / <c>-EncodedCommand</c>
    /// or any of their canonical short forms), case-insensitively.
    /// </summary>
    /// <param name="args">The argv vector to validate.</param>
    /// <returns><see langword="true"/> when at least one forbidden flag is present.</returns>
    public bool ContainsForbiddenFlags(ImmutableArray<string> args)
    {
        foreach (var arg in args)
        {
            if (ForbiddenFlags.Contains(arg))
            {
                return true;
            }
        }

        return false;
    }
}
