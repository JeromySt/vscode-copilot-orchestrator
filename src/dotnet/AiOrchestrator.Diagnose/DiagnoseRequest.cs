// <copyright file="DiagnoseRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Diagnose;

/// <summary>A single diagnose-bundle production request.</summary>
public sealed record DiagnoseRequest
{
    /// <summary>Gets the plan to capture, or <see langword="null"/> to emit a host-only bundle with no plan snapshot.</summary>
    public required PlanId? PlanId { get; init; }

    /// <summary>Gets the absolute path of the <c>.aiodiag</c> archive to produce (must end with a file name).</summary>
    public required AbsolutePath OutputPath { get; init; }

    /// <summary>Gets the event-log lookback window, overriding <see cref="DiagnoseOptions.EventLogWindow"/>.</summary>
    public TimeSpan? EventLogWindow { get; init; }

    /// <summary>Gets the recipient public-key fingerprint used to look up the key in <see cref="DiagnoseOptions.RecipientTrustStore"/>. Required for <see cref="PseudonymizationMode.Reversible"/>.</summary>
    public string? Recipient { get; init; }

    /// <summary>Gets the pseudonymization mode for this bundle, overriding <see cref="DiagnoseOptions.PseudonymizationMode"/>.</summary>
    public PseudonymizationMode? PseudonymizationMode { get; init; }

    /// <summary>Gets a value indicating whether the caller explicitly set the <c>--allow-pii</c> flag for this request, permitting <see cref="Diagnose.PseudonymizationMode.Off"/>.</summary>
    public bool AllowPii { get; init; }

    /// <summary>Gets a fixed timestamp used for the bundle manifest. When <see langword="null"/> (production), the clock is sampled. Exposed for deterministic testing of the rest of the bundle.</summary>
    public DateTimeOffset? OverrideCreatedAt { get; init; }
}
