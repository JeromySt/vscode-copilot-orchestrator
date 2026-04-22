// <copyright file="CGroupV2.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Globalization;

namespace AiOrchestrator.Process.Native.Linux;

/// <summary>
/// Attaches a process to a cgroups v2 hierarchy and applies resource limits
/// by writing to the unified cgroup filesystem at <c>/sys/fs/cgroup</c>.
/// </summary>
internal static class CGroupV2
{
    private const string CGroupRoot = "/sys/fs/cgroup";
    private const string OrchestratorGroup = "aiorch";

    /// <summary>
    /// Creates a cgroup slice for the process and applies memory/CPU limits.
    /// Writing to <c>cgroup.procs</c> attaches the process to the cgroup.
    /// </summary>
    /// <param name="pid">The process ID to attach.</param>
    /// <param name="limits">The resource limits to apply.</param>
    internal static void Apply(int pid, ResourceLimits limits)
    {
        var cgroupDir = Path.Combine(CGroupRoot, OrchestratorGroup, pid.ToString(CultureInfo.InvariantCulture));
        try
        {
            _ = Directory.CreateDirectory(cgroupDir);

            // Attach process to cgroup
            File.WriteAllText(Path.Combine(cgroupDir, "cgroup.procs"), pid.ToString(CultureInfo.InvariantCulture));

            // Memory limit
            if (limits.MaxMemoryBytes.HasValue)
            {
                File.WriteAllText(
                    Path.Combine(cgroupDir, "memory.max"),
                    limits.MaxMemoryBytes.Value.ToString(CultureInfo.InvariantCulture));
            }

            // CPU quota (microseconds per period; 100000 µs period = 100 ms)
            if (limits.MaxCpuTime.HasValue)
            {
                // Express as a fraction of CPU: e.g. 50% = "50000 100000"
                // For max CPU time we set a hard quota via cpu.max
                const long PeriodUs = 100_000L;
                var quotaUs = (long)(limits.MaxCpuTime.Value.TotalSeconds * PeriodUs);
                File.WriteAllText(
                    Path.Combine(cgroupDir, "cpu.max"),
                    FormattableString.Invariant($"{quotaUs} {PeriodUs}"));
            }
        }
        catch (UnauthorizedAccessException)
        {
            // cgroups v2 requires root or CAP_SYS_ADMIN; silently skip if unavailable
        }
        catch (DirectoryNotFoundException)
        {
            // cgroups v2 not mounted; silently skip
        }
    }

    /// <summary>Removes the cgroup created for a process after it exits.</summary>
    /// <param name="pid">The process ID whose cgroup slice should be removed.</param>
    internal static void Cleanup(int pid)
    {
        var cgroupDir = Path.Combine(CGroupRoot, OrchestratorGroup, pid.ToString(CultureInfo.InvariantCulture));
        try
        {
            if (Directory.Exists(cgroupDir))
            {
                Directory.Delete(cgroupDir);
            }
        }
        catch
        {
            // Best-effort cleanup; never throw on cgroup teardown
        }
    }
}
