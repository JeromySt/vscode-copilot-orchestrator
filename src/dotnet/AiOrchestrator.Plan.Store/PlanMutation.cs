// <copyright file="PlanMutation.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Store;

/// <summary>
/// Base record for every persisted state-change to a plan. Each mutation carries
/// a monotonic <see cref="Seq"/> (assigned by the store), an <see cref="IdemKey"/>
/// (RW-2-IDEM), and a store-assigned timestamp.
/// </summary>
/// <param name="Seq">The monotonic sequence number within the owning plan's journal.</param>
/// <param name="IdemKey">The idempotency key used to guard retried writes (RW-2-IDEM).</param>
/// <param name="At">The store-assigned timestamp when the mutation was accepted.</param>
public abstract record PlanMutation(long Seq, IdempotencyKey IdemKey, DateTimeOffset At);
