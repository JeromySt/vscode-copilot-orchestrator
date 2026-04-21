// <copyright file="FetchRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a fetch operation.</summary>
public sealed record FetchRequest
{
    /// <summary>Gets the remote name (default: <c>origin</c>).</summary>
    public string Remote { get; init; } = "origin";

    /// <summary>Gets the principal whose credentials should be used.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the explicit refspecs to fetch (default: remote-configured refspecs).</summary>
    public ImmutableArray<string> RefSpecs { get; init; } = ImmutableArray<string>.Empty;

    /// <summary>Gets a value indicating whether to prune deleted remote refs.</summary>
    public bool Prune { get; init; }
}
