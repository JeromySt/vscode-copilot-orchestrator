// <copyright file="FetchResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Git.Results;

/// <summary>The outcome of a successful fetch.</summary>
/// <param name="ObjectsReceived">Total number of objects transferred.</param>
/// <param name="BytesReceived">Total bytes transferred.</param>
public sealed record FetchResult(int ObjectsReceived, long BytesReceived);
