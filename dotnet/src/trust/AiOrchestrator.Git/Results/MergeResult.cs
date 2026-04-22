// <copyright file="MergeResult.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Results;

/// <summary>Possible outcomes of a merge.</summary>
public enum MergeOutcome
{
    /// <summary>HEAD was already a descendant of the source; nothing changed.</summary>
    UpToDate,

    /// <summary>The merge fast-forwarded.</summary>
    FastForward,

    /// <summary>A merge commit was created.</summary>
    NonFastForward,
}

/// <summary>The outcome of a successful merge.</summary>
/// <param name="Outcome">How the merge completed.</param>
/// <param name="HeadSha">The SHA of HEAD after the merge.</param>
public sealed record MergeResult(MergeOutcome Outcome, CommitSha HeadSha);
