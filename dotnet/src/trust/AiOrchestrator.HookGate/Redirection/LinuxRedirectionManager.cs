// <copyright file="LinuxRedirectionManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.HookGate.Redirection;

/// <summary>
/// POSIX (Linux/macOS) implementation of <see cref="IRedirectionManager"/> (HK-GATE-LINK-1 v1.4).
/// PRIMARY: <c>mount --bind</c> of a read-only source over <c>.git/hooks</c>. Falls back to
/// <c>bindfs</c> when <c>CAP_SYS_ADMIN</c> is unavailable, and finally to a plain symlink —
/// the symlink fallback ALWAYS emits <see cref="HookGateNonceImmutabilityUnsupported"/>.
/// </summary>
[ExcludeFromCodeCoverage(Justification = "POSIX-only implementation; covered by Linux CI only.")]
internal sealed class LinuxRedirectionManager : IRedirectionManager
{
    private readonly IImmutabilityEventSink events;
    private readonly IProcessSpawner spawner;
    private readonly IFileSystem fs;
    private readonly ILogger<LinuxRedirectionManager> logger;
    private readonly TimeSpan timeout = TimeSpan.FromSeconds(5);

    public LinuxRedirectionManager(IImmutabilityEventSink events, IProcessSpawner spawner, IFileSystem fs, ILogger<LinuxRedirectionManager> logger)
    {
        this.events = events ?? throw new ArgumentNullException(nameof(events));
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async ValueTask InstallRedirectionAsync(AbsolutePath gitHooksDir, AbsolutePath canonicalDispatcherPath, CancellationToken ct)
    {
        if (!await this.fs.DirectoryExistsAsync(gitHooksDir, ct).ConfigureAwait(false))
        {
            await this.fs.CreateDirectoryAsync(gitHooksDir, ct).ConfigureAwait(false);
        }

        var (mountCode, _) = await ToolRunner.RunAsync(
            this.spawner,
            "mount",
            ["--bind", "-o", "ro", canonicalDispatcherPath.Value, gitHooksDir.Value],
            this.timeout,
            ct).ConfigureAwait(false);

        if (mountCode == 0)
        {
            this.logger.LogInformation("Installed bind-mount redirection at {Path}.", gitHooksDir.Value);
            return;
        }

        var (bfCode, _) = await ToolRunner.RunAsync(
            this.spawner,
            "bindfs",
            ["-r", canonicalDispatcherPath.Value, gitHooksDir.Value],
            this.timeout,
            ct).ConfigureAwait(false);

        if (bfCode == 0)
        {
            this.logger.LogInformation("Installed bindfs redirection at {Path}.", gitHooksDir.Value);
            return;
        }

        await this.InstallSymlinkAsync(gitHooksDir, canonicalDispatcherPath, ct).ConfigureAwait(false);
        await this.events.PublishAsync(
            new HookGateNonceImmutabilityUnsupported
            {
                Path = gitHooksDir,
                Mechanism = "symlink",
                Reason = "bind-mount and bindfs both unavailable; falling back to symlink",
                At = DateTimeOffset.UtcNow,
            },
            ct).ConfigureAwait(false);
    }

    public async ValueTask UninstallRedirectionAsync(AbsolutePath gitHooksDir, CancellationToken ct)
    {
        var (code, _) = await ToolRunner.RunAsync(this.spawner, "umount", [gitHooksDir.Value], this.timeout, ct).ConfigureAwait(false);
        if (code == 0)
        {
            return;
        }

        try
        {
            if (IsSymlink(gitHooksDir.Value))
            {
                await this.fs.DeleteAsync(gitHooksDir, ct).ConfigureAwait(false);
            }
            else if (await this.fs.DirectoryExistsAsync(gitHooksDir, ct).ConfigureAwait(false))
            {
                await this.fs.DeleteDirectoryAsync(gitHooksDir, recursive: true, ct).ConfigureAwait(false);
            }
        }
        catch (IOException)
        {
            // best effort
        }
    }

    public async ValueTask<RedirectionMode> GetActiveModeAsync(AbsolutePath gitHooksDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!await this.fs.DirectoryExistsAsync(gitHooksDir, ct).ConfigureAwait(false) && !await this.fs.FileExistsAsync(gitHooksDir, ct).ConfigureAwait(false))
        {
            return RedirectionMode.NotInstalled;
        }

        if (IsSymlink(gitHooksDir.Value))
        {
            return RedirectionMode.Symlink;
        }

        try
        {
            if (await this.fs.FileExistsAsync(new AbsolutePath("/proc/self/mountinfo"), ct).ConfigureAwait(false))
            {
                var content = await this.fs.ReadAllTextAsync(new AbsolutePath("/proc/self/mountinfo"), ct).ConfigureAwait(false);
                if (content.Contains(" " + gitHooksDir.Value + " ", StringComparison.Ordinal))
                {
                    return RedirectionMode.BindMount;
                }
            }
        }
        catch (IOException)
        {
            // non-fatal
        }

        return RedirectionMode.NotInstalled;
    }

    private async ValueTask InstallSymlinkAsync(AbsolutePath dst, AbsolutePath src, CancellationToken ct)
    {
        try
        {
            if (await this.fs.DirectoryExistsAsync(dst, ct).ConfigureAwait(false))
            {
                await this.fs.DeleteDirectoryAsync(dst, recursive: true, ct).ConfigureAwait(false);
            }
            else if (await this.fs.FileExistsAsync(dst, ct).ConfigureAwait(false))
            {
                await this.fs.DeleteAsync(dst, ct).ConfigureAwait(false);
            }

#pragma warning disable OE0004 // Directory.CreateSymbolicLink has no IFileSystem equivalent
            _ = Directory.CreateSymbolicLink(dst.Value, src.Value);
#pragma warning restore OE0004
        }
        catch (IOException ex)
        {
            this.logger.LogWarning(ex, "symlink fallback failed for {Path}", dst.Value);
        }
    }

    private static bool IsSymlink(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.LinkTarget is not null;
        }
        catch (IOException)
        {
            return false;
        }
    }
}
