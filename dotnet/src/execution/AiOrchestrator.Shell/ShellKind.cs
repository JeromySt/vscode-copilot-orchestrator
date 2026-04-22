// <copyright file="ShellKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Shell;

/// <summary>
/// Identifies the shell interpreter to invoke for a <see cref="ShellSpec"/>.
/// </summary>
public enum ShellKind
{
    /// <summary>GNU Bash shell (<c>bash</c>).</summary>
    Bash,

    /// <summary>POSIX shell (<c>sh</c>).</summary>
    Sh,

    /// <summary>Windows Command Prompt (<c>cmd.exe</c>).</summary>
    Cmd,

    /// <summary>Windows PowerShell 5.1 (<c>powershell.exe</c>).</summary>
    PowerShell,

    /// <summary>Cross-platform PowerShell 7+ (<c>pwsh</c>).</summary>
    Pwsh,
}
