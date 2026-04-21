// <copyright file="ModelsSerializationContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;
using AiOrchestrator.Models.Redaction;

namespace AiOrchestrator.Models;

/// <summary>Source-generated JSON serialization context for all public model types.</summary>
[JsonSerializable(typeof(WorkSpec))]
[JsonSerializable(typeof(AgentSpec))]
[JsonSerializable(typeof(ShellSpec))]
[JsonSerializable(typeof(ProcessSpec))]
[JsonSerializable(typeof(EventEnvelope))]
[JsonSerializable(typeof(AuthContext))]
[JsonSerializable(typeof(RedactionPolicy))]
public sealed partial class ModelsSerializationContext : JsonSerializerContext
{
}
