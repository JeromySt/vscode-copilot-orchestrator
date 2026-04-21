// <copyright file="AuthContext.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Models.Auth;

/// <summary>Represents the authenticated principal invoking an operation.</summary>
public sealed record AuthContext
{
    /// <summary>Gets the unique identifier of the principal.</summary>
    public required string PrincipalId { get; init; }

    /// <summary>Gets the human-readable display name of the principal.</summary>
    public required string DisplayName { get; init; }

    /// <summary>Gets the authorization scopes granted to the principal.</summary>
    public required ImmutableArray<string> Scopes { get; init; }

    /// <summary>Gets the UTC time at which the credential was issued.</summary>
    public DateTimeOffset IssuedAtUtc { get; init; }

    /// <summary>Gets the UTC time at which the credential expires, if any.</summary>
    public DateTimeOffset? ExpiresAtUtc { get; init; }
}
