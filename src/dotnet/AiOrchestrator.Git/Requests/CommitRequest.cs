// <copyright file="CommitRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a commit to create.</summary>
public sealed record CommitRequest
{
    /// <summary>Gets the commit message.</summary>
    public required string Message { get; init; }

    /// <summary>Gets the author identity.</summary>
    public required AuthContext Author { get; init; }

    /// <summary>Gets the committer identity (defaults to <see cref="Author"/> when null).</summary>
    public AuthContext? Committer { get; init; }

    /// <summary>Gets a value indicating whether to allow an empty commit.</summary>
    public bool AllowEmpty { get; init; }
}
