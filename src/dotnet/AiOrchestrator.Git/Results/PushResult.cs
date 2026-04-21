// <copyright file="PushResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Git.Results;

/// <summary>The outcome of a successful push.</summary>
/// <param name="UpdatedRefs">The remote refs that were updated.</param>
public sealed record PushResult(ImmutableArray<string> UpdatedRefs);
