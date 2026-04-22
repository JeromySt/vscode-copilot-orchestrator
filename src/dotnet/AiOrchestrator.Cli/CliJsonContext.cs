// <copyright file="CliJsonContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AiOrchestrator.Cli;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> used by <see cref="JsonOutputWriter"/>.
/// All CLI JSON output flows through <see cref="System.Text.Json.Serialization.Metadata.JsonTypeInfo{T}"/>
/// obtained from this context; no reflection-based serializer is used.
/// </summary>
[JsonSourceGenerationOptions(WriteIndented = true, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(VerbResult))]
[JsonSerializable(typeof(VersionInfo))]
[JsonSerializable(typeof(PlanStatusDto))]
[JsonSerializable(typeof(DaemonStatusDto))]
[JsonSerializable(typeof(Dictionary<string, string>))]
internal sealed partial class CliJsonContext : JsonSerializerContext
{
}

/// <summary>Generic CLI verb result for machine-readable output.</summary>
/// <param name="Verb">The verb path that produced this result.</param>
/// <param name="Ok">Whether the operation completed successfully.</param>
/// <param name="Message">Optional human-readable message.</param>
/// <param name="ExitCode">The CLI exit code that will be returned.</param>
internal sealed record VerbResult(string Verb, bool Ok, string Message, int ExitCode);

/// <summary>Version information emitted by <c>aio version --json</c>.</summary>
/// <param name="Product">Product name.</param>
/// <param name="Version">Assembly informational version.</param>
/// <param name="Runtime">The .NET runtime description.</param>
internal sealed record VersionInfo(string Product, string Version, string Runtime);

/// <summary>Plan status DTO for JSON output.</summary>
/// <param name="PlanId">The plan id.</param>
/// <param name="State">A state tag (e.g. <c>pending</c>, <c>running</c>, <c>succeeded</c>).</param>
/// <param name="Jobs">Total job count.</param>
/// <param name="Completed">Number of completed jobs.</param>
internal sealed record PlanStatusDto(string PlanId, string State, int Jobs, int Completed);

/// <summary>Daemon status DTO for JSON output.</summary>
/// <param name="Running">Whether the daemon process is currently running.</param>
/// <param name="Pid">Process id if available, otherwise -1.</param>
/// <param name="Endpoint">Human-readable endpoint string.</param>
internal sealed record DaemonStatusDto(bool Running, int Pid, string Endpoint);
