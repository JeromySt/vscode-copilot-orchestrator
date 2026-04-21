// <copyright file="DaemonOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.InteropServices;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Daemon;

/// <summary>
/// Configuration for the daemon update controller and the daemon host.
/// </summary>
public sealed record DaemonOptions
{
    /// <summary>Gets the absolute path of the pid lock-file written on startup.</summary>
    public AbsolutePath PidFile { get; init; } = DefaultPidFile();

    /// <summary>Gets the install root that the update flow swaps in place.</summary>
    public AbsolutePath InstallRoot { get; init; } = DefaultInstallRoot();

    /// <summary>Gets the directory under which downloaded artifacts are staged.</summary>
    public AbsolutePath UpdateStagingRoot { get; init; } = DefaultStagingRoot();

    /// <summary>Gets the URL of the signed release manifest.</summary>
    public string ReleaseManifestUrl { get; init; } = "https://aka.ms/aio/release-manifest.signed.json";

    /// <summary>Gets the polling interval for update checks.</summary>
    public TimeSpan UpdateCheckInterval { get; init; } = TimeSpan.FromHours(6);

    /// <summary>Gets a value indicating whether the offline-root M-of-N HSM signature is required.</summary>
    public bool RequireOfflineRootSignature { get; init; } = true;

    /// <summary>Gets the timeout for graceful shutdown drain.</summary>
    public TimeSpan ShutdownDrainTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Gets the offline-root public key used to verify HSM signatures.</summary>
    public byte[] OfflineRootPubKey { get; init; } = Array.Empty<byte>();

    /// <summary>Gets the minimum number of valid HSM signatures required (M of N).</summary>
    public int MinValidSignatures { get; init; } = 3;

    /// <summary>Gets the daemon executable path used for the post-update self-check.</summary>
    public AbsolutePath? DaemonExecutable { get; init; }

    private static AbsolutePath DefaultPidFile()
    {
        var dir = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? Path.Combine(Path.GetTempPath(), "ai-orchestrator")
            : "/run/ai-orchestrator";
        return new AbsolutePath(Path.Combine(dir, "aio-daemon.pid"));
    }

    private static AbsolutePath DefaultInstallRoot()
    {
        var dir = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? Path.Combine(Path.GetTempPath(), "ai-orchestrator", "install")
            : "/var/lib/ai-orchestrator/install";
        return new AbsolutePath(dir);
    }

    private static AbsolutePath DefaultStagingRoot()
    {
        var dir = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? Path.Combine(Path.GetTempPath(), "ai-orchestrator", "staging")
            : "/var/lib/ai-orchestrator/staging";
        return new AbsolutePath(dir);
    }
}
