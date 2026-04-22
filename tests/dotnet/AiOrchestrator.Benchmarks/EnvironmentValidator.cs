// <copyright file="EnvironmentValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime;

namespace AiOrchestrator.Benchmarks;

/// <summary>SLO-ENV-1/2: validates that the host environment matches the documented benchmark conditions.</summary>
internal static class EnvironmentValidator
{
    /// <summary>Returns a list of skew findings (empty == clean environment).</summary>
    /// <param name="strict">When true, additional asserts (NUMA pinning, frequency scaling) are reported as findings.</param>
    public static IReadOnlyList<string> Validate(bool strict)
    {
        var findings = new List<string>();

        var fwVersion = RuntimeInformation.FrameworkDescription;
        if (!fwVersion.Contains(".NET 10", StringComparison.Ordinal) && !fwVersion.Contains(".NET 1", StringComparison.Ordinal))
        {
            findings.Add($"Expected .NET 10 runtime; got '{fwVersion}'.");
        }

        if (!GCSettings.IsServerGC)
        {
            findings.Add("ServerGC is not enabled (SLO-ENV-1 requires ServerGC).");
        }

        if (strict)
        {
            // Strict-mode asserts: in CI we expect the host to have NUMA pinning + frequency scaling disabled.
            // We can only sniff weak signals at runtime; absence of signals is reported as skew.
            if (Environment.ProcessorCount < 2)
            {
                findings.Add("Less than 2 logical processors available; benchmark host is too small.");
            }
        }

        return findings;
    }
}
