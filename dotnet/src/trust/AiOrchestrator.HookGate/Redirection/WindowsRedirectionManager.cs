// <copyright file="WindowsRedirectionManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.HookGate.Immutability;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.HookGate.Redirection;

/// <summary>
/// Windows implementation of <see cref="IRedirectionManager"/> (HK-GATE-LINK-1-WIN v1.4).
/// PRIMARY: NTFS directory junction (created via <c>cmd /c mklink /J</c>) — works in non-admin
/// contexts. FALLBACK: plain symlink (requires Developer Mode); emits an immutability-
/// unsupported warning.
/// </summary>
internal sealed class WindowsRedirectionManager : IRedirectionManager
{
    private readonly IImmutabilityEventSink events;
    private readonly IProcessSpawner spawner;
    private readonly ILogger<WindowsRedirectionManager> logger;
    private readonly TimeSpan timeout = TimeSpan.FromSeconds(5);

    public WindowsRedirectionManager(IImmutabilityEventSink events, IProcessSpawner spawner, ILogger<WindowsRedirectionManager> logger)
    {
        this.events = events ?? throw new ArgumentNullException(nameof(events));
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async ValueTask InstallRedirectionAsync(AbsolutePath gitHooksDir, AbsolutePath canonicalDispatcherPath, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (Directory.Exists(gitHooksDir.Value))
        {
            try
            {
                Directory.Delete(gitHooksDir.Value, recursive: true);
            }
            catch (IOException)
            {
                // fall through — junction creation will report the real error
            }
        }

        var (code, _) = await ToolRunner.RunAsync(
            this.spawner,
            "cmd.exe",
            ["/c", "mklink", "/J", gitHooksDir.Value, canonicalDispatcherPath.Value],
            this.timeout,
            ct).ConfigureAwait(false);

        if (code == 0)
        {
            this.logger.LogInformation("Installed junction redirection at {Path}.", gitHooksDir.Value);
            return;
        }

        try
        {
            _ = Directory.CreateSymbolicLink(gitHooksDir.Value, canonicalDispatcherPath.Value);
            await this.events.PublishAsync(
                new HookGateNonceImmutabilityUnsupported
                {
                    Path = gitHooksDir,
                    Mechanism = "symlink",
                    Reason = "junction creation failed; using symlink fallback",
                    At = DateTimeOffset.UtcNow,
                },
                ct).ConfigureAwait(false);
        }
        catch (IOException ex)
        {
            this.logger.LogWarning(ex, "symlink fallback failed for {Path}", gitHooksDir.Value);
            throw;
        }
    }

    public ValueTask UninstallRedirectionAsync(AbsolutePath gitHooksDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            if (Directory.Exists(gitHooksDir.Value))
            {
                Directory.Delete(gitHooksDir.Value, recursive: false);
            }
            else if (File.Exists(gitHooksDir.Value))
            {
                File.Delete(gitHooksDir.Value);
            }
        }
        catch (IOException)
        {
            // best effort
        }

        return ValueTask.CompletedTask;
    }

    public async ValueTask<RedirectionMode> GetActiveModeAsync(AbsolutePath gitHooksDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!Directory.Exists(gitHooksDir.Value) && !File.Exists(gitHooksDir.Value))
        {
            return RedirectionMode.NotInstalled;
        }

        try
        {
            var info = new DirectoryInfo(gitHooksDir.Value);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                var (code, stdout) = await ToolRunner.RunAsync(
                    this.spawner,
                    "fsutil.exe",
                    ["reparsepoint", "query", gitHooksDir.Value],
                    this.timeout,
                    ct).ConfigureAwait(false);

                if (code == 0 && stdout.Contains("IO_REPARSE_TAG_MOUNT_POINT", StringComparison.Ordinal))
                {
                    return RedirectionMode.Junction;
                }

                return RedirectionMode.Symlink;
            }
        }
        catch (IOException)
        {
            // fall through
        }

        return RedirectionMode.NotInstalled;
    }
}
