// <copyright file="ProcessSignal.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Process;

/// <summary>Identifies the type of signal to send to a running process.</summary>
public enum ProcessSignal
{
    /// <summary>Requests graceful termination (SIGTERM on POSIX, WM_CLOSE equivalent on Windows).</summary>
    Terminate,

    /// <summary>Forces immediate process termination (SIGKILL on POSIX, TerminateProcess on Windows).</summary>
    Kill,

    /// <summary>Interrupts the process (SIGINT, equivalent to Ctrl+C).</summary>
    Interrupt,
}
