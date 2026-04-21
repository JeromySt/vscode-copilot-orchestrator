// <copyright file="IEventMigration.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Models.Eventing;

/// <summary>
/// Pure function migrating a payload from version <typeparamref name="TFrom"/>
/// to the immediately-adjacent version <typeparamref name="TTo"/>.
/// </summary>
/// <typeparam name="TFrom">Source payload version.</typeparam>
/// <typeparam name="TTo">Target payload version (adjacent).</typeparam>
/// <remarks>
/// The event version source generator (rules EV-GEN-1..3) requires a public
/// implementation of this interface to exist in the compilation for every
/// adjacent <c>(N, N+1)</c> pair of an event type with versions
/// <c>{1, ..., N}</c>. Missing implementations fail the build with
/// diagnostic <c>EVGEN001</c>.
/// </remarks>
public interface IEventMigration<TFrom, TTo>
    where TFrom : notnull
    where TTo : notnull
{
    /// <summary>Migrates the supplied payload to the next version.</summary>
    /// <param name="from">Inbound payload at version <typeparamref name="TFrom"/>.</param>
    /// <returns>Equivalent payload at version <typeparamref name="TTo"/>.</returns>
    TTo Migrate(TFrom from);
}
