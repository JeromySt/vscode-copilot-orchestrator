// <copyright file="WindowsMountInspector.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.FileSystem.Native.Windows;

/// <summary>
/// Windows implementation of <see cref="IMountInspector"/>. Returns <see cref="MountKind.Smb"/>
/// for UNC paths, <see cref="MountKind.Local"/> for local volumes, and uses
/// <c>GetVolumeInformationW</c> + <c>WNetGetConnection</c> as needed.
/// </summary>
/// <remarks>Implements NFS-DET-2 (SMB) and the Windows side of NFS-DET-4 (local).</remarks>
[SupportedOSPlatform("windows")]
#pragma warning disable SA1310 // Field names should not contain underscore — Win32 constants are conventional.
public sealed partial class WindowsMountInspector : IMountInspector
{
    private const int DRIVE_REMOVABLE = 2;
    private const int DRIVE_FIXED = 3;
    private const int DRIVE_REMOTE = 4;
    private const int DRIVE_CDROM = 5;
    private const int DRIVE_RAMDISK = 6;

    /// <summary>Pure classifier for a path string (exposed for tests).</summary>
    /// <param name="path">Absolute Windows path.</param>
    /// <returns>The detected <see cref="MountKind"/>.</returns>
    public static MountKind Classify(string path)
    {
        ArgumentNullException.ThrowIfNull(path);

        // UNC paths: \\server\share or //server/share — likely SMB.
        if (path.StartsWith(@"\\", StringComparison.Ordinal) || path.StartsWith("//", StringComparison.Ordinal))
        {
            return MountKind.Smb;
        }

        if (path.Length < 2 || path[1] != ':')
        {
            return MountKind.Unknown;
        }

        var root = path[..3];
        try
        {
            var driveType = GetDriveType(root);
            return driveType switch
            {
                DRIVE_REMOTE => ClassifyRemote(root),
                DRIVE_FIXED or DRIVE_RAMDISK or DRIVE_REMOVABLE or DRIVE_CDROM => MountKind.Local,
                _ => MountKind.Unknown,
            };
        }
        catch (DllNotFoundException)
        {
            return MountKind.Unknown;
        }
    }

    /// <inheritdoc/>
    public ValueTask<MountKind> InspectAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return new ValueTask<MountKind>(Classify(path.Value));
    }

    private static MountKind ClassifyRemote(string root)
    {
        // For mapped network drives, query GetVolumeInformation for the FS type.
        var volName = new char[261];
        var fsName = new char[261];
        if (GetVolumeInformation(root, volName, volName.Length, out _, out _, out _, fsName, fsName.Length))
        {
            var fs = new string(fsName).TrimEnd('\0').ToUpperInvariant();
            if (fs.Contains("NFS", StringComparison.Ordinal))
            {
                return MountKind.Nfs;
            }

            if (fs.Contains("SMB", StringComparison.Ordinal) || fs == "CIFS")
            {
                return MountKind.Smb;
            }
        }

        // Default for remote drives: assume SMB.
        return MountKind.Smb;
    }

    [LibraryImport("kernel32.dll", EntryPoint = "GetDriveTypeW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial uint GetDriveType(string lpRootPathName);

    [LibraryImport("kernel32.dll", EntryPoint = "GetVolumeInformationW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetVolumeInformation(
        string lpRootPathName,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] char[] lpVolumeNameBuffer,
        int nVolumeNameSize,
        out uint lpVolumeSerialNumber,
        out uint lpMaximumComponentLength,
        out uint lpFileSystemFlags,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 7)] char[] lpFileSystemNameBuffer,
        int nFileSystemNameSize);
}
#pragma warning restore SA1310
