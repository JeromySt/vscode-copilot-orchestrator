// <copyright file="RepoRoot.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace AiOrchestrator.Acceptance;

internal static class RepoRoot
{
    public static string Find()
    {
        DirectoryInfo? dir = new(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "src", "dotnet"))
                && Directory.Exists(Path.Combine(dir.FullName, "tests", "dotnet")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("Cannot locate repo root from " + AppContext.BaseDirectory);
    }
}
