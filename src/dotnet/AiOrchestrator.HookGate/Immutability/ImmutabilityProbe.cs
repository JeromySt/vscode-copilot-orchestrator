// <copyright file="ImmutabilityProbe.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate.Immutability;

/// <summary>
/// Attempts to apply best-effort immutability on a file per OS mechanism (HK-GATE-LINK-2 v1.4).
/// Linux: <c>chattr +i</c>. macOS: <c>chflags uchg</c>. Windows: DACL-deny WRITE (via <c>icacls</c>).
/// All attempts are no-ops when the process lacks the required privilege; this class reports
/// that as <see cref="ImmutabilityResult.Supported"/> == <see langword="false"/>.
/// </summary>
internal sealed class ImmutabilityProbe
{
    private readonly IClock clock;
    private readonly IProcessSpawner spawner;
    private readonly TimeSpan timeout = TimeSpan.FromSeconds(5);

    public ImmutabilityProbe(IClock clock, IProcessSpawner spawner)
    {
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
    }

    public async ValueTask<ImmutabilityResult> ProbeAsync(AbsolutePath path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return await this.TryChattrAsync(path, ct).ConfigureAwait(false);
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return await this.TryChflagsAsync(path, ct).ConfigureAwait(false);
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return await this.TryDaclDenyAsync(path, ct).ConfigureAwait(false);
        }

        return new ImmutabilityResult
        {
            Supported = false,
            Mechanism = "unknown-os",
            FailureReason = "platform not recognized",
        };
    }

    public bool IsImmutabilitySupported(ImmutabilityResult result)
        => result?.Supported ?? false;

    public HookGateNonceImmutabilityUnsupported BuildEvent(AbsolutePath path, ImmutabilityResult result)
        => new()
        {
            Path = path,
            Mechanism = result?.Mechanism ?? "unknown",
            Reason = result?.FailureReason ?? "unsupported",
            At = this.clock.UtcNow,
        };

    [ExcludeFromCodeCoverage(Justification = "Linux-only path; covered by Linux CI only.")]
    private async ValueTask<ImmutabilityResult> TryChattrAsync(AbsolutePath path, CancellationToken ct)
    {
        var (code, _) = await ToolRunner.RunAsync(this.spawner, "chattr", ["+i", path.Value], this.timeout, ct).ConfigureAwait(false);
        return Classify("chattr+i", code);
    }

    [ExcludeFromCodeCoverage(Justification = "macOS-only path; covered by macOS CI only.")]
    private async ValueTask<ImmutabilityResult> TryChflagsAsync(AbsolutePath path, CancellationToken ct)
    {
        var (code, _) = await ToolRunner.RunAsync(this.spawner, "chflags", ["uchg", path.Value], this.timeout, ct).ConfigureAwait(false);
        return Classify("chflags uchg", code);
    }

    private async ValueTask<ImmutabilityResult> TryDaclDenyAsync(AbsolutePath path, CancellationToken ct)
    {
        var (code, _) = await ToolRunner.RunAsync(this.spawner, "icacls.exe", [path.Value, "/deny", "*S-1-1-0:(W)"], this.timeout, ct).ConfigureAwait(false);
        return Classify("DACL-deny", code);
    }

    private static ImmutabilityResult Classify(string mechanism, int exitCode) => exitCode switch
    {
        0 => new ImmutabilityResult { Supported = true, Mechanism = mechanism, FailureReason = null },
        -1 => new ImmutabilityResult { Supported = false, Mechanism = mechanism, FailureReason = "tool unavailable" },
        _ => new ImmutabilityResult { Supported = false, Mechanism = mechanism, FailureReason = $"exit {exitCode}" },
    };
}
