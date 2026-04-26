// <copyright file="ProcessTreeBuilder.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Process.Native.Windows;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.Process;

/// <summary>
/// Builds a <see cref="ProcessTreeNode"/> from platform-native process enumeration.
/// Uses Job Objects on Windows, cgroup.procs on Linux, and proc_listchildpids on macOS.
/// Per-PID stats are collected via lightweight syscalls (no WMI, no System.Diagnostics.Process).
/// </summary>
[ExcludeFromCodeCoverage]
internal static class ProcessTreeBuilder
{
    private const string CGroupRoot = "/sys/fs/cgroup";
    private const string OrchestratorGroup = "aiorch";

    /// <summary>
    /// Builds a process tree using a Windows Job Object handle.
    /// </summary>
    internal static ProcessTreeNode? BuildFromJobObject(SafeFileHandle jobHandle, int rootPid)
    {
        if (jobHandle.IsClosed || jobHandle.IsInvalid)
        {
            return null;
        }

        var pids = JobObjectNative.GetJobProcessIds(jobHandle);
        if (pids.Length == 0)
        {
            return null;
        }

        var statsByPid = new Dictionary<int, ProcessStats>();
        foreach (var pid in pids)
        {
            statsByPid[pid] = GetWindowsStats(pid);
        }

        // Build tree: the root PID is the root node, all others are flat children
        // (Job Object doesn't provide parent-child relationships directly)
        if (!statsByPid.TryGetValue(rootPid, out var rootStats))
        {
            rootStats = new ProcessStats { Pid = rootPid, Name = "<exited>" };
        }

        var children = new List<ProcessTreeNode>();
        foreach (var (pid, stats) in statsByPid)
        {
            if (pid != rootPid)
            {
                children.Add(new ProcessTreeNode { Stats = stats });
            }
        }

        return new ProcessTreeNode
        {
            Stats = rootStats,
            Children = children,
        };
    }

    /// <summary>
    /// Builds a process tree by reading cgroup.procs on Linux.
    /// </summary>
    internal static async ValueTask<ProcessTreeNode?> BuildFromCgroupAsync(int rootPid, IFileSystem fs, CancellationToken ct)
    {
        var cgroupPath = Path.Combine(CGroupRoot, OrchestratorGroup, rootPid.ToString(CultureInfo.InvariantCulture), "cgroup.procs");

        string content;
        try
        {
            content = await fs.ReadAllTextAsync(new AbsolutePath(cgroupPath), ct).ConfigureAwait(false);
        }
        catch
        {
            return null;
        }

        var pids = ParsePidList(content);
        if (pids.Length == 0)
        {
            return null;
        }

        var statsByPid = new Dictionary<int, ProcessStats>();
        foreach (var pid in pids)
        {
            statsByPid[pid] = await GetLinuxStatsAsync(pid, fs, ct).ConfigureAwait(false);
        }

        if (!statsByPid.TryGetValue(rootPid, out var rootStats))
        {
            rootStats = new ProcessStats { Pid = rootPid, Name = "<exited>" };
        }

        // Build parent-child tree from /proc stats (ppid field)
        return BuildTreeFromParentInfo(rootPid, rootStats, statsByPid);
    }

    /// <summary>
    /// Builds a process tree using proc_listchildpids on macOS (recursive).
    /// </summary>
    internal static ProcessTreeNode? BuildFromProcListChildPids(int rootPid)
    {
        var rootStats = GetMacOsStats(rootPid);
        if (rootStats.Name == "<exited>")
        {
            return null;
        }

        return BuildMacOsTreeRecursive(rootPid, rootStats);
    }

    private static ProcessTreeNode BuildMacOsTreeRecursive(int pid, ProcessStats stats)
    {
        var childPids = Native.macOS.ProcNative.GetChildPids(pid);
        var children = new List<ProcessTreeNode>();
        foreach (var childPid in childPids)
        {
            var childStats = GetMacOsStats(childPid);
            children.Add(BuildMacOsTreeRecursive(childPid, childStats));
        }

        return new ProcessTreeNode
        {
            Stats = stats,
            Children = children,
        };
    }

    private static ProcessTreeNode BuildTreeFromParentInfo(int rootPid, ProcessStats rootStats, Dictionary<int, ProcessStats> statsByPid)
    {
        // Group by parent PID
        var childrenOf = new Dictionary<int, List<ProcessStats>>();
        foreach (var (_, stats) in statsByPid)
        {
            if (stats.Pid == rootPid)
            {
                continue;
            }

            var ppid = stats.ParentPid;
            if (!childrenOf.TryGetValue(ppid, out var list))
            {
                list = new List<ProcessStats>();
                childrenOf[ppid] = list;
            }

            list.Add(stats);
        }

        return BuildSubTree(rootPid, rootStats, childrenOf);
    }

    private static ProcessTreeNode BuildSubTree(int pid, ProcessStats stats, Dictionary<int, List<ProcessStats>> childrenOf)
    {
        var children = new List<ProcessTreeNode>();
        if (childrenOf.TryGetValue(pid, out var childStatsList))
        {
            foreach (var childStats in childStatsList)
            {
                children.Add(BuildSubTree(childStats.Pid, childStats, childrenOf));
            }
        }

        return new ProcessTreeNode
        {
            Stats = stats,
            Children = children,
        };
    }

    private static ProcessStats GetWindowsStats(int pid)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new ProcessStats { Pid = pid, Name = "<unsupported>" };
        }

        using var hProcess = CreateProcessNative.OpenProcess(
            ProcessStatsNative.PROCESS_QUERY_LIMITED_INFORMATION | ProcessStatsNative.PROCESS_VM_READ,
            false,
            pid);

        if (hProcess.IsInvalid)
        {
            return new ProcessStats { Pid = pid, Name = "<exited>" };
        }

        // Process name
        string name = "<unknown>";
        var nameBuffer = new char[1024];
        uint nameSize = (uint)nameBuffer.Length;
        if (ProcessStatsNative.QueryFullProcessImageName(hProcess, 0, nameBuffer, ref nameSize))
        {
            var fullPath = new string(nameBuffer, 0, (int)nameSize);
            name = Path.GetFileNameWithoutExtension(fullPath);
        }

        // Memory
        long memoryBytes = 0;
        var memCounters = new ProcessStatsNative.ProcessMemoryCounters();
        memCounters.Cb = (uint)Marshal.SizeOf<ProcessStatsNative.ProcessMemoryCounters>();
        if (ProcessStatsNative.GetProcessMemoryInfo(hProcess, ref memCounters, memCounters.Cb))
        {
            memoryBytes = (long)memCounters.WorkingSetSize;
        }

        // CPU times (kernel + user in 100-ns ticks)
        ProcessStatsNative.GetProcessTimes(hProcess, out _, out _, out long kernelTime, out long userTime);

        // Parent PID via NtQueryInformationProcess
        int parentPid = 0;
        var basicInfo = new ProcessStatsNative.ProcessBasicInformation();
        if (ProcessStatsNative.NtQueryInformationProcess(
            hProcess, 0, ref basicInfo, (uint)Marshal.SizeOf<ProcessStatsNative.ProcessBasicInformation>(), out _) == 0)
        {
            parentPid = (int)basicInfo.InheritedFromUniqueProcessId;
        }

        return new ProcessStats
        {
            Pid = pid,
            ParentPid = parentPid,
            Name = name,
            MemoryBytes = memoryBytes,
            // CPU percent would need delta measurement; report raw ticks as 0 for now
            CpuPercent = 0,
        };
    }

    private static async ValueTask<ProcessStats> GetLinuxStatsAsync(int pid, IFileSystem fs, CancellationToken ct)
    {
        string name = "<unknown>";
        int ppid = 0;
        long memoryBytes = 0;
        int threadCount = 0;

        // Parse /proc/{pid}/stat: fields are: pid (comm) state ppid ...
        try
        {
            var statContent = await fs.ReadAllTextAsync(
                new AbsolutePath($"/proc/{pid}/stat"), ct).ConfigureAwait(false);

            // comm is in parentheses and may contain spaces — find last ')'
            var commEnd = statContent.LastIndexOf(')');
            if (commEnd > 0)
            {
                var commStart = statContent.IndexOf('(');
                if (commStart >= 0 && commStart < commEnd)
                {
                    name = statContent.Substring(commStart + 1, commEnd - commStart - 1);
                }

                // Fields after ") " are: state ppid ...
                var rest = statContent.AsSpan(commEnd + 2);
                var fields = rest.ToString().Split(' ');
                if (fields.Length > 1 && int.TryParse(fields[1], CultureInfo.InvariantCulture, out var parsedPpid))
                {
                    ppid = parsedPpid;
                }

                // Field index 17 (0-based after comm) = num_threads
                if (fields.Length > 17 && int.TryParse(fields[17], CultureInfo.InvariantCulture, out var threads))
                {
                    threadCount = threads;
                }
            }
        }
        catch
        {
            // Process may have exited
        }

        // Parse /proc/{pid}/status for VmRSS
        try
        {
            var statusContent = await fs.ReadAllTextAsync(
                new AbsolutePath($"/proc/{pid}/status"), ct).ConfigureAwait(false);

            foreach (var line in statusContent.Split('\n'))
            {
                if (line.StartsWith("VmRSS:", StringComparison.Ordinal))
                {
                    // Format: "VmRSS:    12345 kB"
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && long.TryParse(parts[1], CultureInfo.InvariantCulture, out var kbValue))
                    {
                        memoryBytes = kbValue * 1024;
                    }

                    break;
                }
            }
        }
        catch
        {
            // Process may have exited
        }

        return new ProcessStats
        {
            Pid = pid,
            ParentPid = ppid,
            Name = name,
            MemoryBytes = memoryBytes,
            ThreadCount = threadCount,
        };
    }

    private static ProcessStats GetMacOsStats(int pid)
    {
        // On macOS we have limited info without sysctl — return basics
        return new ProcessStats
        {
            Pid = pid,
            Name = "<unknown>",
        };
    }

    private static int[] ParsePidList(string content)
    {
        var lines = content.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var pids = new List<int>(lines.Length);
        foreach (var line in lines)
        {
            if (int.TryParse(line.Trim(), CultureInfo.InvariantCulture, out var pid))
            {
                pids.Add(pid);
            }
        }

        return pids.ToArray();
    }
}
