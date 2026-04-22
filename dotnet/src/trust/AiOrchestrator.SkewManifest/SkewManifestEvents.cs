// <copyright file="SkewManifestEvents.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.SkewManifest;

/// <summary>Event published when a new manifest has been successfully verified and stored.</summary>
public sealed record SkewManifestUpdated
{
    /// <summary>Gets the manifest version that is now current.</summary>
    public required Version ManifestVersion { get; init; }

    /// <summary>Gets the UTC time at which the manifest was fetched.</summary>
    public required DateTimeOffset FetchedAt { get; init; }
}

/// <summary>Event published when the current manifest has exceeded <c>StaleAfter</c>.</summary>
public sealed record SkewManifestStale
{
    /// <summary>Gets the <see cref="SkewManifest.SignedAt"/> value of the stale manifest.</summary>
    public required DateTimeOffset SignedAt { get; init; }

    /// <summary>Gets the current UTC time when staleness was detected.</summary>
    public required DateTimeOffset ObservedAt { get; init; }
}
