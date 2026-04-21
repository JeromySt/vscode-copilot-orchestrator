// <copyright file="EnvScope.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace AiOrchestrator.Process;

/// <summary>
/// Describes the environment variable scope for a spawned child process.
/// When <see cref="InheritOther"/> is <see langword="false"/> (the default),
/// the child receives <em>only</em> the variables listed in <see cref="Allowed"/>;
/// no keys from the parent environment are inherited implicitly.
/// </summary>
public sealed record EnvScope
{
    /// <summary>Gets the set of environment variable names and values that the child process may see.</summary>
    public required ImmutableDictionary<string, string> Allowed { get; init; }

    /// <summary>
    /// Gets a value indicating whether the child inherits environment variables from the parent
    /// that are not listed in <see cref="Allowed"/>. Defaults to <see langword="false"/>.
    /// </summary>
    public bool InheritOther { get; init; } = false;

    /// <summary>Creates an <see cref="EnvScope"/> that only allows the specified variables.</summary>
    /// <param name="vars">The allowed variables.</param>
    /// <returns>A new <see cref="EnvScope"/> with <see cref="InheritOther"/> set to <see langword="false"/>.</returns>
    public static EnvScope Restricted(ImmutableDictionary<string, string> vars)
        => new() { Allowed = vars };

    /// <summary>Creates an <see cref="EnvScope"/> that inherits all parent variables plus the specified additions.</summary>
    /// <param name="additions">Additional variables to add or override.</param>
    /// <returns>A new <see cref="EnvScope"/> with <see cref="InheritOther"/> set to <see langword="true"/>.</returns>
    public static EnvScope Inherited(ImmutableDictionary<string, string>? additions = null)
        => new() { Allowed = additions ?? ImmutableDictionary<string, string>.Empty, InheritOther = true };
}
