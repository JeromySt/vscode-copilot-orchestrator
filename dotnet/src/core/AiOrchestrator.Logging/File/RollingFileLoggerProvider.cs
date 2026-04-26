// <copyright file="RollingFileLoggerProvider.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Logging.File;

/// <summary>
/// A file-based logger that writes CompactJSON log lines to rolling files.
/// Used for both global daemon logs and per-repo diagnostic logs.
/// </summary>
public sealed class RollingFileLoggerProvider : ILoggerProvider
{
    private readonly string filePath;
    private readonly long maxFileSizeBytes;
    private readonly int maxRetainedFiles;
    private readonly object writeLock = new();
    private StreamWriter? writer;

    /// <summary>
    /// Initializes a new instance of the <see cref="RollingFileLoggerProvider"/> class.
    /// </summary>
    /// <param name="options">Configuration for file path, size limits, and retention.</param>
    public RollingFileLoggerProvider(RollingFileLoggerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        this.filePath = options.FilePath;
        this.maxFileSizeBytes = options.MaxFileSizeBytes;
        this.maxRetainedFiles = options.MaxRetainedFiles;

        var dir = Path.GetDirectoryName(this.filePath);
        if (!string.IsNullOrEmpty(dir))
        {
#pragma warning disable OE0004 // ILoggerProvider constructor must be synchronous; no async IFileSystem path available
            Directory.CreateDirectory(dir);
#pragma warning restore OE0004
        }

        this.writer = new StreamWriter(
            new FileStream(this.filePath, FileMode.Append, FileAccess.Write, FileShare.Read),
            System.Text.Encoding.UTF8)
        {
            AutoFlush = true,
        };
    }

    /// <inheritdoc/>
    public ILogger CreateLogger(string categoryName) =>
        new RollingFileLogger(categoryName, this);

    /// <inheritdoc/>
    public void Dispose()
    {
        lock (this.writeLock)
        {
            this.writer?.Dispose();
            this.writer = null;
        }
    }

    /// <summary>Writes a single log line and rolls the file if the size threshold is exceeded.</summary>
    internal void Write(string line)
    {
        lock (this.writeLock)
        {
            if (this.writer is null)
            {
                return;
            }

            this.writer.WriteLine(line);

            if (this.writer.BaseStream.Length >= this.maxFileSizeBytes)
            {
                this.Roll();
            }
        }
    }

    private void Roll()
    {
        this.writer?.Dispose();
        this.writer = null;

        // Shift rolled files: .{n-1} → .{n}, ... , .1 → .2
#pragma warning disable OE0004 // Roll() is called under lock from synchronous Write(); no async IFileSystem path available
        for (int i = this.maxRetainedFiles - 1; i >= 1; i--)
        {
            var src = $"{this.filePath}.{i}";
            var dst = $"{this.filePath}.{i + 1}";
            if (System.IO.File.Exists(src))
            {
                if (System.IO.File.Exists(dst))
                {
                    System.IO.File.Delete(dst);
                }

                System.IO.File.Move(src, dst);
            }
        }

        // Move current → .1
        if (System.IO.File.Exists(this.filePath))
        {
            System.IO.File.Move(this.filePath, $"{this.filePath}.1");
        }
#pragma warning restore OE0004

        this.writer = new StreamWriter(
            new FileStream(this.filePath, FileMode.Create, FileAccess.Write, FileShare.Read),
            System.Text.Encoding.UTF8)
        {
            AutoFlush = true,
        };
    }
}
