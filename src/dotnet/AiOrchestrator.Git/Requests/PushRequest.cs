// <copyright file="PushRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a push operation.</summary>
public sealed record PushRequest
{
    /// <summary>Gets the remote name (default: <c>origin</c>).</summary>
    public string Remote { get; init; } = "origin";

    /// <summary>Gets the principal whose credentials should be used.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets the refspecs to push.</summary>
    public required ImmutableArray<string> RefSpecs { get; init; }

    /// <summary>Gets a value indicating whether to allow non-fast-forward updates.</summary>
    public bool Force { get; init; }
}
