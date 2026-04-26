// <copyright file="CeremonyTranscriptWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Tools.KeyCeremony.Transcript;

/// <summary>Appends timestamped JSON-line records to a ceremony transcript file (INV-3).</summary>
public interface ITranscriptWriter
{
    /// <summary>Append a transcript record. Flushed so a crash mid-ceremony preserves audit.</summary>
    /// <param name="action">A short action label (e.g., "connect", "sign").</param>
    /// <param name="operatorId">The operator that performed the action.</param>
    /// <param name="deviceSerial">The HSM device serial reported.</param>
    /// <param name="payloadSha256Hex">SHA-256 hex of the payload signed (or empty for non-sign actions).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task representing the async operation.</returns>
    ValueTask AppendAsync(string action, HsmOperatorId operatorId, string deviceSerial, string payloadSha256Hex, CancellationToken ct = default);
}

/// <summary>File-based transcript writer that appends and flushes on every call.</summary>
public sealed class CeremonyTranscriptWriter : ITranscriptWriter
{
    private readonly AbsolutePath path;
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly SemaphoreSlim gate = new(1, 1);

    /// <summary>Initializes a new instance of the <see cref="CeremonyTranscriptWriter"/> class.</summary>
    /// <param name="path">Absolute file path to append transcript lines to.</param>
    /// <param name="fs">Filesystem abstraction.</param>
    /// <param name="clock">Clock used to timestamp entries.</param>
    public CeremonyTranscriptWriter(string path, IFileSystem fs, IClock clock)
    {
        this.path = new AbsolutePath(path);
        this.fs = fs;
        this.clock = clock;
    }

    /// <summary>Ensures the parent directory for the transcript file exists.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task representing the async operation.</returns>
    public async ValueTask EnsureDirectoryAsync(CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(this.path.Value);
        if (!string.IsNullOrEmpty(dir))
        {
            await this.fs.CreateDirectoryAsync(new AbsolutePath(dir), ct).ConfigureAwait(false);
        }
    }

    /// <inheritdoc/>
    public async ValueTask AppendAsync(string action, HsmOperatorId operatorId, string deviceSerial, string payloadSha256Hex, CancellationToken ct)
    {
        var record = new
        {
            ts = this.clock.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            action,
            operator_ = operatorId.Value,
            deviceSerial,
            payloadSha256 = payloadSha256Hex,
        };
        var line = JsonSerializer.Serialize(record) + Environment.NewLine;
        await this.gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Open/append/flush every call so an abort mid-ceremony preserves audit.
            await using var stream = await this.fs.OpenAppendAsync(this.path, ct).ConfigureAwait(false);
            await stream.WriteAsync(Encoding.UTF8.GetBytes(line), ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            this.gate.Release();
        }
    }
}
