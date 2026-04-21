// <copyright file="RefUpdate.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Results;

/// <summary>The outcome of an optimistic ref update (CAS).</summary>
/// <param name="RefName">The qualified ref name.</param>
/// <param name="OldTarget">The previous SHA the ref pointed at.</param>
/// <param name="NewTarget">The SHA the ref now points at.</param>
public sealed record RefUpdate(string RefName, CommitSha OldTarget, CommitSha NewTarget);
