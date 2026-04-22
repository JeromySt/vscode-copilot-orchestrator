// <copyright file="FencingToken.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Globalization;

namespace AiOrchestrator.WorktreeLease;

/// <summary>
/// Monotonically increasing token that identifies a specific lease acquisition.
/// Every acquire and renew produces a strictly greater token (LS-CAS-3).
/// </summary>
/// <param name="Value">The underlying counter value (starts at 1).</param>
public readonly record struct FencingToken(long Value) : IComparable<FencingToken>
{
    /// <summary>Returns <see langword="true"/> if <paramref name="left"/> is less than <paramref name="right"/>.</summary>
    /// <param name="left">The first token.</param>
    /// <param name="right">The second token.</param>
    /// <returns><see langword="true"/> if <paramref name="left"/> precedes <paramref name="right"/>; otherwise <see langword="false"/>.</returns>
    public static bool operator <(FencingToken left, FencingToken right) => left.CompareTo(right) < 0;

    /// <summary>Returns <see langword="true"/> if <paramref name="left"/> is greater than <paramref name="right"/>.</summary>
    /// <param name="left">The first token.</param>
    /// <param name="right">The second token.</param>
    /// <returns><see langword="true"/> if <paramref name="left"/> follows <paramref name="right"/>; otherwise <see langword="false"/>.</returns>
    public static bool operator >(FencingToken left, FencingToken right) => left.CompareTo(right) > 0;

    /// <summary>Returns <see langword="true"/> if <paramref name="left"/> is less than or equal to <paramref name="right"/>.</summary>
    /// <param name="left">The first token.</param>
    /// <param name="right">The second token.</param>
    /// <returns><see langword="true"/> if <paramref name="left"/> is less than or equal to <paramref name="right"/>.</returns>
    public static bool operator <=(FencingToken left, FencingToken right) => left.CompareTo(right) <= 0;

    /// <summary>Returns <see langword="true"/> if <paramref name="left"/> is greater than or equal to <paramref name="right"/>.</summary>
    /// <param name="left">The first token.</param>
    /// <param name="right">The second token.</param>
    /// <returns><see langword="true"/> if <paramref name="left"/> is greater than or equal to <paramref name="right"/>.</returns>
    public static bool operator >=(FencingToken left, FencingToken right) => left.CompareTo(right) >= 0;

    /// <inheritdoc/>
    public int CompareTo(FencingToken other) => this.Value.CompareTo(other.Value);

    /// <inheritdoc/>
    public override string ToString() => this.Value.ToString(CultureInfo.InvariantCulture);
}
