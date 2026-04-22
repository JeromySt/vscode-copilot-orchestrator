// <copyright file="DiagnoseOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace AiOrchestrator.Diagnose;

/// <summary>Options controlling how diagnose bundles are produced (§3.18 / §3.31.1.3).</summary>
public sealed record DiagnoseOptions
{
    /// <summary>Gets the default pseudonymization mode used when a request does not specify one.</summary>
    public PseudonymizationMode PseudonymizationMode { get; init; } = PseudonymizationMode.Anonymous;

    /// <summary>Gets the default lookback window for event-log inclusion.</summary>
    public TimeSpan EventLogWindow { get; init; } = TimeSpan.FromHours(2);

    /// <summary>Gets a value indicating whether the audit log is included in the bundle.</summary>
    public bool IncludeAuditLog { get; init; } = true;

    /// <summary>Gets a value indicating whether worktree directory listings are included.</summary>
    public bool IncludeWorktreeListings { get; init; }

    /// <summary>Gets a value indicating whether <see cref="System.Environment.GetEnvironmentVariables()"/> snapshot is embedded. Defaults to <see langword="false"/> because env variables may contain tokens (INV-7).</summary>
    public bool IncludeProcessEnv { get; init; }

    /// <summary>Gets the list of recipient public key fingerprints trusted for <see cref="PseudonymizationMode.Reversible"/> mappings.</summary>
    public IReadOnlyDictionary<string, byte[]> RecipientTrustStore { get; init; } = new Dictionary<string, byte[]>(StringComparer.Ordinal);

    /// <summary>Gets a value indicating whether the caller explicitly passed <c>--allow-pii</c>, permitting <see cref="PseudonymizationMode.Off"/> (INV-4).</summary>
    public bool AllowPii { get; init; }

    /// <summary>Gets the version string recorded in the bundle manifest.</summary>
    public string AioVersion { get; init; } = "0.1.0";

    /// <summary>Gets the idle timeout used when draining the event reader. Exposed for tests.</summary>
    public TimeSpan EventReaderIdleTimeout { get; init; } = TimeSpan.FromMilliseconds(50);
}
