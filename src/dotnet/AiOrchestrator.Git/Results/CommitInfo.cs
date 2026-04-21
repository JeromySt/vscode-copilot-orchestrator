// <copyright file="CommitInfo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Ids;

namespace AiOrchestrator.Git.Results;

/// <summary>Metadata about a single commit returned from the walk or commit creation APIs.</summary>
/// <param name="Sha">The commit SHA.</param>
/// <param name="Message">The commit message (subject + body).</param>
/// <param name="AuthorName">The author's display name.</param>
/// <param name="AuthorEmail">The author's email address.</param>
/// <param name="AuthorDateUtc">The author timestamp in UTC.</param>
/// <param name="CommitterName">The committer's display name.</param>
/// <param name="CommitterEmail">The committer's email address.</param>
/// <param name="CommitterDateUtc">The committer timestamp in UTC (sourced from <see cref="Abstractions.Time.IClock"/>; INV-7).</param>
public sealed record CommitInfo(
    CommitSha Sha,
    string Message,
    string AuthorName,
    string AuthorEmail,
    DateTimeOffset AuthorDateUtc,
    string CommitterName,
    string CommitterEmail,
    DateTimeOffset CommitterDateUtc);
