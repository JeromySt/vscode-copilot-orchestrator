// <copyright file="CliExitCodes.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;

namespace AiOrchestrator.Cli;

/// <summary>
/// Canonical process exit codes used by the <c>aio</c> CLI. Values conform to §3.14.7.
/// </summary>
[ExcludeFromCodeCoverage]
public sealed class CliExitCodes
{
    private CliExitCodes()
    {
    }

    /// <summary>Operation completed successfully.</summary>
    public const int Ok = 0;

    /// <summary>Invalid arguments or usage error (EX_USAGE).</summary>
    public const int UsageError = 64;

    /// <summary>Configuration file could not be parsed or validated (EX_CONFIG).</summary>
    public const int ConfigError = 65;

    /// <summary>Input/output error reading or writing files (EX_IOERR).</summary>
    public const int IoError = 74;

    /// <summary>Operation refused due to insufficient privileges (EX_NOPERM).</summary>
    public const int PermissionDenied = 77;

    /// <summary>A plan finished with at least one failed job.</summary>
    public const int PlanFailed = 80;

    /// <summary>A plan was canceled before reaching a terminal success state.</summary>
    public const int PlanCanceled = 81;

    /// <summary>A plan finished with a mix of succeeded and failed/canceled jobs.</summary>
    public const int PlanPartial = 82;

    /// <summary>The orchestrator daemon was unreachable or unavailable.</summary>
    public const int DaemonUnavailable = 90;

    /// <summary>An unhandled internal error occurred.</summary>
    public const int InternalError = 99;
}
