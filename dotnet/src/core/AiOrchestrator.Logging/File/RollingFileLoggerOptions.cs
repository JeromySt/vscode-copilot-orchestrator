// <copyright file="RollingFileLoggerOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Logging.File;

/// <summary>
/// Options for <see cref="RollingFileLoggerProvider"/>.
/// </summary>
public sealed record RollingFileLoggerOptions
{
    /// <summary>Gets the absolute path to the log file.</summary>
    public required string FilePath { get; init; }

    /// <summary>Gets the maximum size in bytes before rolling. Default 10 MB.</summary>
    public long MaxFileSizeBytes { get; init; } = 10 * 1024 * 1024;

    /// <summary>Gets the number of rolled files to retain. Default 5.</summary>
    public int MaxRetainedFiles { get; init; } = 5;
}
