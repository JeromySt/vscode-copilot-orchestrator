// <copyright file="AuditOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Audit;

/// <summary>Configures size and time thresholds that drive audit-segment rollover.</summary>
public sealed record AuditOptions
{
    /// <summary>Gets the maximum wall-clock age of a segment before a new one is started. Defaults to 24h.</summary>
    public TimeSpan SegmentRollover { get; init; } = TimeSpan.FromHours(24);

    /// <summary>Gets the maximum size in bytes of a segment file before a new one is started. Defaults to 64 MiB.</summary>
    public long SegmentMaxBytes { get; init; } = 64L * 1024 * 1024;

    /// <summary>
    /// Gets a value indicating whether strict verification additionally
    /// consults a Sigstore-style transparency log (TRUST-ROOT-6).
    /// </summary>
    public bool RequireTransparencyLog { get; init; }
}
