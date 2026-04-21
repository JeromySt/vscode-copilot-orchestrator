// <copyright file="HookGateOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Runtime.InteropServices;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate;

/// <summary>Options controlling <see cref="HookGateDaemon"/> behaviour.</summary>
public sealed record HookGateOptions
{
    /// <summary>Gets the interval at which nonces rotate (INV-5). Default 5 minutes.</summary>
    public TimeSpan NonceRotation { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Gets the absolute UDS path for the POSIX listener.</summary>
    public AbsolutePath SocketPath { get; init; } = DefaultSocketPath();

    /// <summary>Gets the named-pipe name for the Windows listener.</summary>
    public string PipeName { get; init; } = @"\\.\pipe\AiOrchestratorHookGate";

    /// <summary>
    /// Gets a value indicating whether best-effort immutability MUST be supported.
    /// When true, the daemon logs a warning when immutability cannot be applied (INV-3).
    /// </summary>
    public bool RequireImmutability { get; init; }

    /// <summary>Gets the approval-token time-to-live (INV-6). Default 2 minutes.</summary>
    public TimeSpan ApprovalTokenTtl { get; init; } = TimeSpan.FromMinutes(2);

    private static AbsolutePath DefaultSocketPath()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return new AbsolutePath(@"C:\ProgramData\ai-orchestrator\hookgate.sock");
        }

        return new AbsolutePath("/run/ai-orchestrator/hookgate.sock");
    }
}
