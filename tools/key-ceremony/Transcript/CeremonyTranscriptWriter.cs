// <copyright file="CeremonyTranscriptWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.Json;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Tools.KeyCeremony.Transcript;

/// <summary>Appends timestamped JSON-line records to a ceremony transcript file (INV-3).</summary>
public interface ITranscriptWriter
{
    /// <summary>Append a transcript record. Synchronous + flushed so a crash mid-ceremony preserves audit.</summary>
    /// <param name="action">A short action label (e.g., "connect", "sign").</param>
    /// <param name="operatorId">The operator that performed the action.</param>
    /// <param name="deviceSerial">The HSM device serial reported.</param>
    /// <param name="payloadSha256Hex">SHA-256 hex of the payload signed (or empty for non-sign actions).</param>
    void Append(string action, HsmOperatorId operatorId, string deviceSerial, string payloadSha256Hex);
}

/// <summary>File-based transcript writer that appends and flushes on every call.</summary>
public sealed class CeremonyTranscriptWriter : ITranscriptWriter
{
    private readonly string path;
    private readonly IClock clock;
    private readonly object lockObj = new();

    /// <summary>Initializes a new instance of the <see cref="CeremonyTranscriptWriter"/> class.</summary>
    /// <param name="path">Absolute file path to append transcript lines to.</param>
    /// <param name="clock">Clock used to timestamp entries.</param>
    public CeremonyTranscriptWriter(string path, IClock clock)
    {
        this.path = path;
        this.clock = clock;
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }
    }

    /// <inheritdoc/>
    public void Append(string action, HsmOperatorId operatorId, string deviceSerial, string payloadSha256Hex)
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
        lock (this.lockObj)
        {
            // Open/append/flush every call so an abort mid-ceremony preserves audit.
            File.AppendAllText(this.path, line);
        }
    }
}
