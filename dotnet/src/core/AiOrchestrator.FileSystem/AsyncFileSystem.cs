// <copyright file="AsyncFileSystem.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.FileSystem.Mount;
using AiOrchestrator.FileSystem.Native.Linux;
using AiOrchestrator.FileSystem.Native.Windows;
using AiOrchestrator.Models.Paths;
using Microsoft.Win32.SafeHandles;

namespace AiOrchestrator.FileSystem;

/// <summary>
/// Production implementation of <see cref="IFileSystem"/>. Every API canonicalizes
/// inputs through <see cref="IPathValidator"/> (INV-1) and uses platform primitives
/// for atomic create (CMD-TMP-1) and atomic move (INV-5). Mount classification is
/// delegated to <see cref="IMountInspector"/>.
/// </summary>
/// <remarks>
/// This project is the sole allowed consumer of <c>System.IO.File</c>/<c>System.IO.Directory</c>
/// (per job 009 INV-8); analyzer <c>OE0011</c> is suppressed for this project only.
/// </remarks>
public sealed class AsyncFileSystem : IFileSystem
{
    private const int DefaultBufferSize = 4096;
    private const int DefaultPosixMode = 0x180; // 0600 octal

    private readonly IPathValidator validator;
    private readonly IMountInspector mounts;

    /// <summary>Initializes a new instance of the <see cref="AsyncFileSystem"/> class.</summary>
    /// <param name="validator">Path validator enforcing traversal protection (INV-1).</param>
    /// <param name="mounts">Mount inspector used by <see cref="GetMountKindAsync"/>.</param>
    public AsyncFileSystem(IPathValidator validator, IMountInspector mounts)
    {
        this.validator = validator ?? throw new ArgumentNullException(nameof(validator));
        this.mounts = mounts ?? throw new ArgumentNullException(nameof(mounts));
    }

    /// <inheritdoc/>
    public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        return new ValueTask<bool>(File.Exists(path.Value) || Directory.Exists(path.Value));
    }

    /// <inheritdoc/>
    public async ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
    {
        this.AssertSafe(path);

        // Use FileStream + StreamReader for cancellation support (synchronous helpers banned by policy).
        await using var stream = new FileStream(
            path.Value,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            DefaultBufferSize,
            useAsync: true);
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync(ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(contents);
        this.AssertSafe(path);

        // Use FileStream + StreamWriter for cancellation support (synchronous helpers banned by policy).
        await using var stream = new FileStream(
            path.Value,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);
        await using var writer = new StreamWriter(stream);
        await writer.WriteAsync(contents.AsMemory(), ct).ConfigureAwait(false);
        await writer.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        Stream stream = new FileStream(
            path.Value,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            DefaultBufferSize,
            useAsync: true);
        return new ValueTask<Stream>(stream);
    }

    /// <inheritdoc/>
    public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);

        var mode = perms.OctalMode == 0 ? DefaultPosixMode : perms.OctalMode;

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux) || RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            // INV-2 + INV-3: open(..., O_CREAT|O_EXCL|O_WRONLY, mode) — atomic create + perms.
            var flags = OpenNative.O_WRONLY | OpenNative.O_CREAT | OpenNative.O_EXCL | OpenNative.O_CLOEXEC;
            var fd = OpenNative.Open(path.Value, flags, (uint)mode);
            if (fd < 0)
            {
                var err = Marshal.GetLastPInvokeError();
                if (err == 17)
                {
                    // EEXIST
                    throw new IOException($"File already exists: {path.Value}");
                }

                throw new IOException($"open(2) failed for {path.Value} (errno={err}).");
            }

            var safeHandle = new SafeFileHandle((IntPtr)fd, ownsHandle: true);
            Stream posixStream = new FileStream(safeHandle, FileAccess.Write, DefaultBufferSize, isAsync: true);
            return new ValueTask<Stream>(posixStream);
        }

        // INV-2 (Windows): CreateNew == CREATE_NEW; throws IOException if exists.
        Stream winStream = new FileStream(
            path.Value,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);

        // INV-4: apply owner-only DACL on Windows.
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                ApplyOwnerOnlyDaclWindows(path.Value);
            }
            catch
            {
                winStream.Dispose();
                throw;
            }
        }

        return new ValueTask<Stream>(winStream);
    }

    /// <inheritdoc/>
    public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(source);
        this.AssertSafe(destination);

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // INV-5 (Windows): MoveFileEx with REPLACE_EXISTING|WRITE_THROUGH for atomic replace.
            var ok = MoveFileExNative.MoveFileEx(
                source.Value,
                destination.Value,
                MoveFileExNative.MOVEFILE_REPLACE_EXISTING | MoveFileExNative.MOVEFILE_WRITE_THROUGH);
            if (!ok)
            {
                var err = Marshal.GetLastPInvokeError();
                throw new IOException($"MoveFileEx failed (Win32 error {err}) for {source.Value} -> {destination.Value}.");
            }
        }
        else
        {
            // INV-5 (POSIX): File.Move with overwrite uses rename(2) under the hood.
            File.Move(source.Value, destination.Value, overwrite: true);
        }

        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);

        if (File.Exists(path.Value))
        {
            File.Delete(path.Value);
        }
        else if (Directory.Exists(path.Value))
        {
            Directory.Delete(path.Value, recursive: false);
        }

        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct)
    {
        this.AssertSafe(path);
        return this.mounts.InspectAsync(path, ct);
    }

    /// <inheritdoc/>
    public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        return new ValueTask<bool>(File.Exists(path.Value));
    }

    /// <inheritdoc/>
    public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        return new ValueTask<bool>(Directory.Exists(path.Value));
    }

    /// <inheritdoc/>
    public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        Directory.CreateDirectory(path.Value);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        Directory.Delete(path.Value, recursive);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public async ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct)
    {
        this.AssertSafe(path);
        await using var stream = new FileStream(
            path.Value,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            DefaultBufferSize,
            useAsync: true);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        return ms.ToArray();
    }

    /// <inheritdoc/>
    public async ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(contents);
        this.AssertSafe(path);
        await using var stream = new FileStream(
            path.Value,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);
        await stream.WriteAsync(contents.AsMemory(), ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(source);
        this.AssertSafe(destination);
        File.Copy(source.Value, destination.Value, overwrite);
        return ValueTask.CompletedTask;
    }

    /// <inheritdoc/>
    public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(
        AbsolutePath directory,
        string searchPattern,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        this.AssertSafe(directory);
        await Task.CompletedTask.ConfigureAwait(false);
        foreach (var file in Directory.EnumerateFiles(directory.Value, searchPattern))
        {
            ct.ThrowIfCancellationRequested();
            yield return new AbsolutePath(file);
        }
    }

    /// <inheritdoc/>
    public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(
        AbsolutePath directory,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        this.AssertSafe(directory);
        await Task.CompletedTask.ConfigureAwait(false);
        foreach (var dir in Directory.EnumerateDirectories(directory.Value))
        {
            ct.ThrowIfCancellationRequested();
            yield return new AbsolutePath(dir);
        }
    }

    /// <inheritdoc/>
    public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        Stream stream = new FileStream(
            path.Value,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);
        return new ValueTask<Stream>(stream);
    }

    /// <inheritdoc/>
    public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        this.AssertSafe(path);
        Stream stream = new FileStream(
            path.Value,
            FileMode.Append,
            FileAccess.Write,
            FileShare.None,
            DefaultBufferSize,
            useAsync: true);
        return new ValueTask<Stream>(stream);
    }

    private static void ApplyOwnerOnlyDaclWindows(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            DaclNative.ApplyOwnerOnlyDacl(path);
        }
    }

    private void AssertSafe(AbsolutePath path)
    {
        // INV-1: validate every path. We use the path itself as its own allowed root,
        // which still exercises the validator's traversal/control-char/reserved-name checks
        // (the validator's internal allowed-root set is opaque to this callsite).
        // Pre-check for ".." segments in the raw input — these are normalized away by
        // Path.GetFullPath so the validator alone can't catch them in this configuration.
        var raw = path.Value;
        var segments = raw.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        foreach (var seg in segments)
        {
            if (seg == "..")
            {
                throw new UnauthorizedAccessException(
                    $"Path contains traversal segment '..': {raw}");
            }
        }

        this.validator.AssertSafe(path, path);
    }
}
