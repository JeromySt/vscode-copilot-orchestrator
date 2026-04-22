// <copyright file="IConcurrencyBroker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Models.Auth;

namespace AiOrchestrator.Abstractions.Concurrency;

/// <summary>
/// Admits units of work into the system subject to per-user and host-level
/// concurrency budgets. Disposing the returned handle releases the slot.
/// </summary>
public interface IConcurrencyBroker
{
    /// <summary>Acquires a concurrency slot for the given principal.</summary>
    /// <param name="principal">The principal whose budget the slot is charged against.</param>
    /// <param name="hint">Scheduling hints describing the work that wants to run.</param>
    /// <param name="ct">Cancellation token. Cancellation withdraws the request before admission.</param>
    /// <returns>An <see cref="IDisposable"/> that releases the slot when disposed.</returns>
    ValueTask<IDisposable> AcquireAsync(AuthContext principal, ConcurrencyHint hint, CancellationToken ct);
}
