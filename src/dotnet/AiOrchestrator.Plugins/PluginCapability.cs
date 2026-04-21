// <copyright file="PluginCapability.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Plugins;

/// <summary>
/// Defines the capabilities that a plugin may declare via <see cref="PluginCapabilityAttribute"/>.
/// Any capability-bound host action MUST call <see cref="Capability.CapabilityChecker.EnforceAtCallSiteAsync"/>
/// before proceeding (enforced by analyzer OE0042).
/// </summary>
public enum PluginCapability
{
    /// <summary>Plugin may read files from the host file system.</summary>
    ReadFiles,

    /// <summary>Plugin may write files to the host file system.</summary>
    WriteFiles,

    /// <summary>Plugin may spawn child processes.</summary>
    RunProcesses,

    /// <summary>Plugin may make outbound network calls.</summary>
    NetworkAccess,

    /// <summary>Plugin may read from the audit log.</summary>
    ReadAuditLog,

    /// <summary>Plugin may append records to the audit log.</summary>
    WriteAuditLog,

    /// <summary>Plugin may access credential stores.</summary>
    AccessCredentials,
}
