// <copyright file="WorkingDirectoryNotFoundException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Shell.Exceptions;

/// <summary>
/// Thrown by <see cref="ShellRunner"/> (INV-10) when the working directory specified
/// in a <see cref="ShellSpec"/> does not exist. No process is spawned.
/// </summary>
public sealed class WorkingDirectoryNotFoundException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="WorkingDirectoryNotFoundException"/> class.</summary>
    /// <param name="workingDirectory">The missing working directory.</param>
    public WorkingDirectoryNotFoundException(AbsolutePath workingDirectory)
        : base($"Working directory does not exist: '{workingDirectory.Value}'")
    {
        this.WorkingDirectory = workingDirectory;
    }

    /// <summary>Initializes a new instance of the <see cref="WorkingDirectoryNotFoundException"/> class.</summary>
    public WorkingDirectoryNotFoundException()
        : base("Working directory does not exist.")
    {
        this.WorkingDirectory = default;
    }

    /// <summary>Initializes a new instance of the <see cref="WorkingDirectoryNotFoundException"/> class.</summary>
    /// <param name="message">Error message.</param>
    public WorkingDirectoryNotFoundException(string message)
        : base(message)
    {
        this.WorkingDirectory = default;
    }

    /// <summary>Initializes a new instance of the <see cref="WorkingDirectoryNotFoundException"/> class.</summary>
    /// <param name="message">Error message.</param>
    /// <param name="innerException">Inner exception.</param>
    public WorkingDirectoryNotFoundException(string message, Exception innerException)
        : base(message, innerException)
    {
        this.WorkingDirectory = default;
    }

    /// <summary>Gets the working directory that was not found.</summary>
    public AbsolutePath WorkingDirectory { get; }
}
