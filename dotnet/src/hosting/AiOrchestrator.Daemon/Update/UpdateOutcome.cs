// <copyright file="UpdateOutcome.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Daemon.Update;

#pragma warning disable CA1707 // Identifiers should not contain underscores — outcome names are part of the public contract.

/// <summary>The terminal outcome of a single update check/apply cycle.</summary>
public enum UpdateOutcome
{
    /// <summary>No newer manifest was available.</summary>
    NoUpdate,

    /// <summary>The update was applied successfully and the post-swap health check passed.</summary>
    Applied,

    /// <summary>The manifest was rejected because it lacked enough valid HSM signatures.</summary>
    Rejected_BadSignature,

    /// <summary>The manifest was rejected because its version was not strictly newer than the current install.</summary>
    Rejected_VersionRegression,

    /// <summary>The manifest was rejected because the current install is below MinSupportedVersion.</summary>
    Rejected_DowngradeBlocked,

    /// <summary>The fetch or download failed due to a transient network error.</summary>
    Failed_Network,

    /// <summary>The swap failed due to a disk error.</summary>
    Failed_Disk,

    /// <summary>The update was applied but the post-swap health check failed and the install was rolled back.</summary>
    RolledBack,
}

#pragma warning restore CA1707
