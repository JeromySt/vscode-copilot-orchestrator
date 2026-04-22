// <copyright file="ShellKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models;

/// <summary>The supported shell interpreter types.</summary>
public enum ShellKind
{
    /// <summary>GNU Bash shell.</summary>
    Bash,

    /// <summary>POSIX sh shell.</summary>
    Sh,

    /// <summary>Windows Command Prompt.</summary>
    Cmd,

    /// <summary>Windows PowerShell (powershell.exe).</summary>
    PowerShell,

    /// <summary>PowerShell Core (pwsh).</summary>
    Pwsh,
}
