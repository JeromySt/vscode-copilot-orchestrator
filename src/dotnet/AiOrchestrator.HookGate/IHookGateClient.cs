// <copyright file="IHookGateClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.HookGate;

/// <summary>
/// Client for the out-of-process <see cref="HookGateDaemon"/>. Hook processes call
/// <see cref="CheckInAsync"/> to obtain an unforgeable <see cref="HookApproval"/> before
/// performing any effect.
/// </summary>
public interface IHookGateClient
{
    /// <summary>
    /// Presents a check-in to the daemon and returns the resulting approval.
    /// </summary>
    /// <param name="request">The check-in request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>An approval token valid for <see cref="HookGateOptions.ApprovalTokenTtl"/>.</returns>
    /// <exception cref="Exceptions.HookApprovalDeniedException">Thrown when the daemon denies the check-in.</exception>
    ValueTask<HookApproval> CheckInAsync(HookCheckInRequest request, CancellationToken ct);
}
