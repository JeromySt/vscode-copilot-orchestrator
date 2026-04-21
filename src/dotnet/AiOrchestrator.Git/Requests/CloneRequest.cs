// <copyright file="CloneRequest.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Git.Requests;

/// <summary>Specifies a clone operation.</summary>
public sealed record CloneRequest
{
    /// <summary>Gets the URL of the source repository.</summary>
    public required Uri SourceUrl { get; init; }

    /// <summary>Gets the local destination path.</summary>
    public required AbsolutePath Destination { get; init; }

    /// <summary>Gets the principal whose credentials should be used.</summary>
    public required AuthContext Principal { get; init; }

    /// <summary>Gets a value indicating whether to create a bare repository (default <see langword="false"/>, INV-9).</summary>
    public bool IsBare { get; init; }

    /// <summary>Gets the optional partial-clone filter (e.g. <c>blob:none</c>); flows through shell when LG2 lacks support.</summary>
    public string? Filter { get; init; }

    /// <summary>Gets the branch to check out after clone, or <see langword="null"/> for the remote default.</summary>
    public string? Branch { get; init; }
}
