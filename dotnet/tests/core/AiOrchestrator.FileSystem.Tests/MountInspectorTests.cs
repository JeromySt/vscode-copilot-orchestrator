// <copyright file="MountInspectorTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.FileSystem.Native.Linux;
using AiOrchestrator.FileSystem.Native.Windows;
using AiOrchestrator.Foundation.Tests;
using Xunit;

namespace AiOrchestrator.FileSystem.Tests;

/// <summary>Acceptance tests for NFS-DET-1..4 — mount classification across platforms.</summary>
public sealed class MountInspectorTests
{
    [Fact]
    [ContractTest("NFS-DET-1")]
    public void NFS_DET_1_DetectsNfsMount_Linux()
    {
        var fixture = LoadFixture("mountinfo-nfs.txt");
        var kind = LinuxMountInspector.ClassifyForPath(fixture, "/mnt/nfsshare/data.bin");
        Assert.Equal(MountKind.Nfs, kind);
    }

    [Fact]
    [ContractTest("NFS-DET-2")]
    public void NFS_DET_2_DetectsSmbMount_Windows()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // Use the pure classifier on a UNC path — works cross-platform.
            Assert.Equal(MountKind.Smb, WindowsMountInspector.Classify(@"\\server\share\file.txt"));
            return;
        }

        Assert.Equal(MountKind.Smb, WindowsMountInspector.Classify(@"\\server\share\file.txt"));
    }

    [Fact]
    [ContractTest("NFS-DET-3")]
    public void NFS_DET_3_DetectsCifsMount_Linux()
    {
        var fixture = LoadFixture("mountinfo-cifs.txt");
        var kind = LinuxMountInspector.ClassifyForPath(fixture, "/mnt/winshare/file.bin");
        Assert.Equal(MountKind.Smb, kind);
    }

    [Fact]
    [ContractTest("NFS-DET-4")]
    public void NFS_DET_4_ReturnsLocalForOrdinaryDisk()
    {
        var fixture = LoadFixture("mountinfo-local.txt");
        var kind = LinuxMountInspector.ClassifyForPath(fixture, "/home/user/file.txt");
        Assert.Equal(MountKind.Local, kind);
    }

    [Fact]
    public async Task LinuxMountInspector_RealFile_RoundTrips()
    {
        // J9-PC-5: NFS-DET tests use real /proc/self/mountinfo fixtures.
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "mountinfo-nfs.txt");
        var inspector = new LinuxMountInspector(fixturePath);
        var kind = await inspector.InspectAsync(new AiOrchestrator.Models.Paths.AbsolutePath("/mnt/nfsshare/x"), default);
        Assert.Equal(MountKind.Nfs, kind);
    }

    [Fact]
    public async Task LinuxMountInspector_MissingMountInfo_ReturnsUnknown()
    {
        var inspector = new LinuxMountInspector(Path.Combine(AppContext.BaseDirectory, "no-such-file.txt"));
        var kind = await inspector.InspectAsync(new AiOrchestrator.Models.Paths.AbsolutePath("/x"), default);
        Assert.Equal(MountKind.Unknown, kind);
    }

    [Fact]
    public async Task LinuxMountInspector_LocalFixture_ReturnsLocal()
    {
        var fixturePath = Path.Combine(AppContext.BaseDirectory, "Fixtures", "mountinfo-local.txt");
        var inspector = new LinuxMountInspector(fixturePath);
        var kind = await inspector.InspectAsync(new AiOrchestrator.Models.Paths.AbsolutePath("/home/user/file.txt"), default);
        Assert.Equal(MountKind.Local, kind);
    }

    [Fact]
    public void WindowsMountInspector_Classify_HandlesShortAndUncPaths()
    {
        Assert.Equal(MountKind.Unknown, WindowsMountInspector.Classify("X"));
        Assert.Equal(MountKind.Smb, WindowsMountInspector.Classify("//server/share/x"));
    }

    [Fact]
    public async Task WindowsMountInspector_InspectAsync_RealLocalDrive()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return; // platform-bound test
        }

        var inspector = new WindowsMountInspector();
        using var temp = new TempDir();
        var kind = await inspector.InspectAsync(new AiOrchestrator.Models.Paths.AbsolutePath(temp.Path), default);
        Assert.Equal(MountKind.Local, kind);
    }

    [Fact]
    public void LinuxMountInspector_DefaultCtor_DoesNotThrow()
    {
        // Exercises the default constructor that points at /proc/self/mountinfo.
        var inspector = new LinuxMountInspector();
        Assert.NotNull(inspector);
    }

    [Fact]
    public void LinuxMountInspector_NullMountInfoPath_Throws()
    {
        var act = () => new LinuxMountInspector(null!);
        Assert.Throws<ArgumentNullException>(act);
    }

    [Fact]
    public void LinuxMountInspector_ClassifyForPath_NullArgs_Throws()
    {
        Action act1 = () => LinuxMountInspector.ClassifyForPath(null!, "/x");
        Action act2 = () => LinuxMountInspector.ClassifyForPath(Array.Empty<string>(), null!);
        Assert.Throws<ArgumentNullException>(act1);
        Assert.Throws<ArgumentNullException>(act2);
    }

    [Fact]
    public void LinuxMountInspector_ClassifyForPath_HandlesEscapesAndMalformedLines()
    {
        // mountinfo line with \040 (space) escape in mount point + a malformed line that must be skipped.
        var lines = new[]
        {
            "garbage line that should be ignored",
            "36 35 8:1 / /mnt/with\\040space rw - nfs server:/x rw",
        };
        var kind = LinuxMountInspector.ClassifyForPath(lines, "/mnt/with space/file.txt");
        Assert.Equal(MountKind.Nfs, kind);
    }

    [Fact]
    public void LinuxMountInspector_MapFsType_DistinguishesSmbAndLocalAndUnknown()
    {
        // smb3 prefix
        Assert.Equal(MountKind.Smb, LinuxMountInspector.ClassifyForPath(
            new[] { "1 1 0:0 / / rw - smb3 //x/y rw" },
            "/file"));

        // ext4 = local
        Assert.Equal(MountKind.Local, LinuxMountInspector.ClassifyForPath(
            new[] { "1 1 0:0 / / rw - ext4 /dev/sda1 rw" },
            "/file"));

        // No matching mount point -> Unknown
        Assert.Equal(MountKind.Unknown, LinuxMountInspector.ClassifyForPath(
            new[] { "1 1 0:0 / /mnt/other rw - ext4 /dev/sda1 rw" },
            "/file"));
    }

    private static string[] LoadFixture(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", name);
        return File.ReadAllLines(path);
    }
}
