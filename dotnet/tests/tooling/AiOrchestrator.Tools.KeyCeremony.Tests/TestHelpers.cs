// <copyright file="TestHelpers.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Tools.KeyCeremony.Tests;

internal static class RepoRoot
{
    public static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, ".github")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("Could not locate repo root from " + AppContext.BaseDirectory);
    }
}

internal sealed class TestClock : IClock
{
    public DateTimeOffset UtcNow { get; set; } = new(2025, 1, 2, 3, 4, 5, TimeSpan.Zero);

    public long MonotonicMilliseconds { get; set; }
}

internal sealed class FakeNetworkProbe : INetworkProbe
{
    public bool NetworkUp { get; set; }
}

internal sealed class FakeHsmClient : IHsmClient
{
    public ConcurrentDictionary<string, int> SignCalls { get; } = new();

    public ValueTask<HsmDeviceInfo> ConnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => ValueTask.FromResult(new HsmDeviceInfo
        {
            DeviceSerial = "SER-" + operator_.Value,
            FirmwareVersion = "1.0",
            PublicKey = new byte[32],
            KeyId = "key-" + operator_.Value,
        });

    public ValueTask<byte[]> SignAsync(HsmOperatorId operator_, byte[] payloadHash, CancellationToken ct)
    {
        this.SignCalls.AddOrUpdate(operator_.Value, 1, (_, c) => c + 1);
        var sig = new byte[64];
        Array.Fill(sig, (byte)operator_.Value[0]);
        return ValueTask.FromResult(sig);
    }

    public ValueTask DisconnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => ValueTask.CompletedTask;
}

/// <summary>Real-disk-backed IFileSystem for tests; writes under a temp dir under repo .orchestrator/tmp.</summary>
internal sealed class DiskFileSystem : IFileSystem
{
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult(File.Exists(path.Value) || Directory.Exists(path.Value));

    public async ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
        => await File.ReadAllTextAsync(path.Value, ct).ConfigureAwait(false);

    public async ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        await File.WriteAllTextAsync(path.Value, contents, ct).ConfigureAwait(false);
    }

    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult<Stream>(File.OpenRead(path.Value));

    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
        => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.CreateNew, FileAccess.Write, FileShare.None));

    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        File.Move(source.Value, destination.Value, overwrite: true);
        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        if (File.Exists(path.Value))
        {
            File.Delete(path.Value);
        }
        else if (Directory.Exists(path.Value))
        {
            Directory.Delete(path.Value, recursive: true);
        }

        return ValueTask.CompletedTask;
    }

    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult(MountKind.Local);

    public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult(File.Exists(path.Value));

    public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult(Directory.Exists(path.Value));

    public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct)
    {
        Directory.CreateDirectory(path.Value);
        return ValueTask.CompletedTask;
    }

    public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct)
    {
        Directory.Delete(path.Value, recursive);
        return ValueTask.CompletedTask;
    }

    public async ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct)
        => await File.ReadAllBytesAsync(path.Value, ct).ConfigureAwait(false);

    public async ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct)
        => await File.WriteAllBytesAsync(path.Value, contents, ct).ConfigureAwait(false);

    public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct)
    {
        File.Copy(source.Value, destination.Value, overwrite);
        return ValueTask.CompletedTask;
    }

    public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(AbsolutePath directory, string searchPattern, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask;
        foreach (var f in Directory.EnumerateFiles(directory.Value, searchPattern))
        {
            ct.ThrowIfCancellationRequested();
            yield return new AbsolutePath(f);
        }
    }

    public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(AbsolutePath directory, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask;
        foreach (var d in Directory.EnumerateDirectories(directory.Value))
        {
            ct.ThrowIfCancellationRequested();
            yield return new AbsolutePath(d);
        }
    }

    public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write));

    public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct)
        => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Append, FileAccess.Write));
}

internal static class CeremonyTestEnv
{
    public static string NewWorkDir()
    {
        var root = RepoRoot.Find();
        var dir = Path.Combine(root, ".orchestrator", "tmp", "ceremony-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    public static string WriteUnsignedManifest(string dir)
    {
        var path = Path.Combine(dir, "release-manifest.unsigned.json");
        // Schema mirrors AiOrchestrator.Daemon.Update.SignedReleaseManifest fields (without Signatures).
        var json = """
            {
              "Version": "1.2.3",
              "Artifacts": [
                {
                  "Filename": "daemon-linux-x64.tgz",
                  "Sha256": "abc123",
                  "Bytes": 12345,
                  "DownloadUrl": "https://example.com/daemon-linux-x64.tgz"
                }
              ],
              "SignedAt": "2025-01-02T03:04:05+00:00",
              "MinSupportedVersion": "1.0.0",
              "TrustedAuditPubKeys": [ "AAECAwQFBgc=" ]
            }
            """;
        File.WriteAllText(path, json);
        return path;
    }
}
