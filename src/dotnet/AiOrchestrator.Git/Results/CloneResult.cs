// <copyright file="CloneResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Results;

/// <summary>The outcome of a successful clone.</summary>
/// <param name="LocalPath">The path of the cloned repository on disk.</param>
/// <param name="HeadSha">The SHA of HEAD after the clone completes.</param>
public sealed record CloneResult(AbsolutePath LocalPath, CommitSha HeadSha);
