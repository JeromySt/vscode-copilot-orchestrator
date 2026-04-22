// <copyright file="LinuxRedirectionManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
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
    private readonly ILogger<LinuxRedirectionManager> logger;
    private readonly TimeSpan timeout = TimeSpan.FromSeconds(5);

    public LinuxRedirectionManager(IImmutabilityEventSink events, IProcessSpawner spawner, ILogger<LinuxRedirectionManager> logger)
    {
        this.events = events ?? throw new ArgumentNullException(nameof(events));
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async ValueTask InstallRedirectionAsync(AbsolutePath gitHooksDir, AbsolutePath canonicalDispatcherPath, CancellationToken ct)
    {
        if (!Directory.Exists(gitHooksDir.Value))
        {
            _ = Directory.CreateDirectory(gitHooksDir.Value);
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

        this.InstallSymlink(gitHooksDir, canonicalDispatcherPath);
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
                File.Delete(gitHooksDir.Value);
            }
            else if (Directory.Exists(gitHooksDir.Value))
            {
                Directory.Delete(gitHooksDir.Value, recursive: true);
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
        if (!Directory.Exists(gitHooksDir.Value) && !File.Exists(gitHooksDir.Value))
        {
            return RedirectionMode.NotInstalled;
        }

        if (IsSymlink(gitHooksDir.Value))
        {
            return RedirectionMode.Symlink;
        }

        try
        {
            if (File.Exists("/proc/self/mountinfo"))
            {
                var content = await System.IO.File.ReadAllTextAsync("/proc/self/mountinfo", ct).ConfigureAwait(false);
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

    private void InstallSymlink(AbsolutePath dst, AbsolutePath src)
    {
        try
        {
            if (Directory.Exists(dst.Value))
            {
                Directory.Delete(dst.Value, recursive: true);
            }
            else if (File.Exists(dst.Value))
            {
                File.Delete(dst.Value);
            }

            _ = Directory.CreateSymbolicLink(dst.Value, src.Value);
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
