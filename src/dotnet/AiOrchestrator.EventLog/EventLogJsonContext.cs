// <copyright file="EventLogJsonContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;
using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.EventLog;

/// <summary>Source-generated JSON serialization context for envelopes persisted by the log.</summary>
[JsonSerializable(typeof(EventEnvelope))]
internal sealed partial class EventLogJsonContext : JsonSerializerContext
{
}
