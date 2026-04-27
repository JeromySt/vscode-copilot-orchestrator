// <copyright file="TsPlanFormat.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text.Json.Serialization;

#pragma warning disable OE0001 // Internal DTO classes for JSON deserialization — no public API surface

namespace AiOrchestrator.Plan.Store.Migration;

/// <summary>Represents the legacy TypeScript plan.json root object.</summary>
internal sealed class TsPlanFormat
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("spec")]
    public TsSpec? Spec { get; set; }

    [JsonPropertyName("jobs")]
    public List<TsJob>? Jobs { get; set; }

    [JsonPropertyName("nodeStates")]
    public Dictionary<string, TsNodeState>? NodeStates { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("createdAt")]
    public long? CreatedAt { get; set; }

    [JsonPropertyName("startedAt")]
    public long? StartedAt { get; set; }

    [JsonPropertyName("endedAt")]
    public long? EndedAt { get; set; }
}

/// <summary>TS plan spec block.</summary>
internal sealed class TsSpec
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
}

/// <summary>TS plan job entry from the jobs array.</summary>
internal sealed class TsJob
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("task")]
    public string Task { get; set; } = string.Empty;

    [JsonPropertyName("dependencies")]
    public List<string>? Dependencies { get; set; }
}

/// <summary>TS plan nodeState entry.</summary>
internal sealed class TsNodeState
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("attempts")]
    public int Attempts { get; set; }

    [JsonPropertyName("scheduledAt")]
    public long? ScheduledAt { get; set; }

    [JsonPropertyName("stateHistory")]
    public List<TsStateTransition>? StateHistory { get; set; }

    [JsonPropertyName("lastAttempt")]
    public TsLastAttempt? LastAttempt { get; set; }
}

/// <summary>TS plan stateHistory entry.</summary>
internal sealed class TsStateTransition
{
    [JsonPropertyName("from")]
    public string? From { get; set; }

    [JsonPropertyName("to")]
    public string? To { get; set; }

    [JsonPropertyName("timestamp")]
    public long? Timestamp { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }
}

/// <summary>TS plan lastAttempt block.</summary>
internal sealed class TsLastAttempt
{
    [JsonPropertyName("startedAt")]
    public long? StartedAt { get; set; }

    [JsonPropertyName("endedAt")]
    public long? EndedAt { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}
