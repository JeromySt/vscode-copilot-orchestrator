// <copyright file="AuthContextFilter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Abstractions.Eventing;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Eventing;

namespace AiOrchestrator.Eventing;

/// <summary>
/// Stateless evaluator that decides whether a given <see cref="EventEnvelope"/> should be
/// delivered to a subscription with the supplied <see cref="EventFilter"/>.
/// Evaluation always uses <see cref="EventFilter.SubscribingPrincipal"/> (pinned at subscribe
/// time, EVT-AUTH-1) and ignores the current principal for authorisation
/// decisions (EVT-AUTH-2).
/// </summary>
internal sealed class AuthContextFilter
{
    /// <summary>Wildcard scope that allows the bearer to read events authored by any principal.</summary>
    public const string ReadAllScope = "events:read:all";

    /// <summary>
    /// Evaluates whether the envelope passes the filter.
    /// </summary>
    /// <param name="filter">The subscription filter, including pinned principal.</param>
    /// <param name="envelope">The event envelope.</param>
    /// <param name="currentPrincipal">
    /// The principal currently invoking the bus. Intentionally NOT used for authorisation
    /// — exists only so callers can assert pinning behaviour (EVT-AUTH-2).
    /// </param>
    /// <returns><see langword="true"/> when the envelope should be delivered.</returns>
    public bool Matches(EventFilter filter, EventEnvelope envelope, AuthContext currentPrincipal)
    {
        ArgumentNullException.ThrowIfNull(filter);
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(currentPrincipal);

        // EVT-AUTH-2: explicitly read pinned principal, never the current one.
        var pinned = filter.SubscribingPrincipal;
        if (pinned is null)
        {
            return false;
        }

        if (filter.PlanId.HasValue && envelope.PlanId != filter.PlanId.Value)
        {
            return false;
        }

        if (filter.JobId.HasValue && envelope.JobId != filter.JobId.Value)
        {
            return false;
        }

        // EVT-AUTH-3: cross-principal events are blocked unless pinned subscriber holds the wildcard scope.
        if (envelope.PrincipalId is { } owner
            && !string.Equals(owner, pinned.PrincipalId, StringComparison.Ordinal)
            && !pinned.Scopes.Contains(ReadAllScope))
        {
            return false;
        }

        if (filter.Predicate is { } pred && !pred(envelope))
        {
            return false;
        }

        return true;
    }
}
