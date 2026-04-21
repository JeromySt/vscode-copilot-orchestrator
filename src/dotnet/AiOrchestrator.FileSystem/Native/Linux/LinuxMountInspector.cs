// <copyright file="LinuxMountInspector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.FileSystem.Native.Linux;

/// <summary>
/// Linux implementation of <see cref="IMountInspector"/> that parses
/// <c>/proc/self/mountinfo</c> to detect NFS, SMB/CIFS, and local mounts.
/// </summary>
/// <remarks>
/// Implements NFS-DET-1 (NFS), NFS-DET-3 (CIFS), and NFS-DET-4 (local fallback).
/// </remarks>
public sealed class LinuxMountInspector : IMountInspector
{
    private const string DefaultMountInfoPath = "/proc/self/mountinfo";

    private readonly string mountInfoPath;

    /// <summary>Initializes a new instance of the <see cref="LinuxMountInspector"/> class.</summary>
    public LinuxMountInspector()
        : this(DefaultMountInfoPath)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LinuxMountInspector"/> class with a custom mountinfo path (for testing).</summary>
    /// <param name="mountInfoPath">Path to a <c>mountinfo</c>-formatted file.</param>
    public LinuxMountInspector(string mountInfoPath)
    {
        this.mountInfoPath = mountInfoPath ?? throw new ArgumentNullException(nameof(mountInfoPath));
    }

    /// <summary>
    /// Pure parser exposed for tests: classifies <paramref name="targetPath"/> against
    /// the supplied <c>mountinfo</c> lines without touching the real filesystem.
    /// </summary>
    /// <param name="mountInfoLines">Raw lines from a <c>/proc/self/mountinfo</c>-formatted file.</param>
    /// <param name="targetPath">Absolute path under inspection.</param>
    /// <returns>The detected <see cref="MountKind"/>.</returns>
    public static MountKind ClassifyForPath(IReadOnlyList<string> mountInfoLines, string targetPath)
    {
        ArgumentNullException.ThrowIfNull(mountInfoLines);
        ArgumentNullException.ThrowIfNull(targetPath);

        // Find the longest mount-point prefix that matches targetPath, then map its fstype.
        string? bestMount = null;
        string? bestFsType = null;

        foreach (var line in mountInfoLines)
        {
            if (TryParseMountInfo(line, out var mountPoint, out var fsType) &&
                IsPathUnder(targetPath, mountPoint) &&
                (bestMount is null || mountPoint.Length > bestMount.Length))
            {
                bestMount = mountPoint;
                bestFsType = fsType;
            }
        }

        return MapFsType(bestFsType);
    }

    /// <inheritdoc/>
    public async ValueTask<MountKind> InspectAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (!File.Exists(this.mountInfoPath))
        {
            return MountKind.Unknown;
        }

        // Stream the mountinfo content asynchronously; sync read-all helpers are banned by policy.
        string[] lines;
        using (var reader = new StreamReader(this.mountInfoPath))
        {
            var content = await reader.ReadToEndAsync(ct).ConfigureAwait(false);
            lines = content.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        }

        return ClassifyForPath(lines, path.Value);
    }

    private static MountKind MapFsType(string? fsType)
    {
        if (string.IsNullOrEmpty(fsType))
        {
            return MountKind.Unknown;
        }

        var fs = fsType.ToLowerInvariant();
        if (fs == "nfs" || fs == "nfs4" || fs.StartsWith("nfs", StringComparison.Ordinal))
        {
            return MountKind.Nfs;
        }

        if (fs == "cifs" || fs == "smb3" || fs == "smbfs" || fs.StartsWith("smb", StringComparison.Ordinal))
        {
            return MountKind.Smb;
        }

        return MountKind.Local;
    }

    private static bool IsPathUnder(string path, string mountPoint)
    {
        if (path == mountPoint)
        {
            return true;
        }

        if (mountPoint == "/")
        {
            return true;
        }

        return path.StartsWith(mountPoint + "/", StringComparison.Ordinal);
    }

    private static bool TryParseMountInfo(string line, out string mountPoint, out string fsType)
    {
        mountPoint = string.Empty;
        fsType = string.Empty;

        // mountinfo format (kernel docs):
        //   36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw,errors=continue
        //   field 5 = mount point; "-" separator; first field after "-" = fstype.
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 7)
        {
            return false;
        }

        var sepIndex = Array.IndexOf(parts, "-");
        if (sepIndex < 0 || sepIndex + 1 >= parts.Length)
        {
            return false;
        }

        mountPoint = UnescapeMountInfo(parts[4]);
        fsType = parts[sepIndex + 1];
        return true;
    }

    private static string UnescapeMountInfo(string value)
    {
        // mountinfo escapes space/tab/newline/backslash as \040 \011 \012 \134.
        if (value.IndexOf('\\', StringComparison.Ordinal) < 0)
        {
            return value;
        }

        var sb = new System.Text.StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            if (value[i] == '\\' && i + 3 < value.Length)
            {
                var oct = value.Substring(i + 1, 3);
                if (int.TryParse(oct, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out _))
                {
                    _ = sb.Append((char)Convert.ToInt32(oct, 8));
                    i += 3;
                    continue;
                }
            }

            _ = sb.Append(value[i]);
        }

        return sb.ToString();
    }
}
