// <copyright file="DaemonArtifact.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Daemon.Update;

/// <summary>One downloadable artifact described by a signed release manifest.</summary>
public sealed record DaemonArtifact
{
    /// <summary>Gets the file name (relative, no path separators) the artifact must be saved as.</summary>
    public required string Filename { get; init; }

    /// <summary>Gets the lowercase hex SHA-256 digest of the artifact bytes.</summary>
    public required string Sha256 { get; init; }

    /// <summary>Gets the artifact size in bytes.</summary>
    public required long Bytes { get; init; }

    /// <summary>Gets the URL the artifact is fetched from.</summary>
    public required Uri DownloadUrl { get; init; }
}
