// <copyright file="PeerInfo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Credentials.Ipc;

/// <summary>
/// Peer-process credentials captured from a live UDS / named-pipe connection
/// (INV-3 / CRED-IPC-2). On Linux <see cref="Uid"/> comes from <c>SO_PEERCRED</c>;
/// on Windows <see cref="UserSid"/> comes from <c>ImpersonateNamedPipeClient</c>.
/// </summary>
public sealed record PeerInfo
{
    /// <summary>Gets the remote process identifier.</summary>
    public required int Pid { get; init; }

    /// <summary>Gets the remote user id (POSIX). <c>0</c> on platforms where not applicable.</summary>
    public required uint Uid { get; init; }

    /// <summary>Gets the remote user's security identifier (Windows). <see langword="null"/> on POSIX.</summary>
    public required string? UserSid { get; init; }
}

/// <summary>Raised when a peer's credentials do not match the expected owner (INV-4 / CRED-IPC-3).</summary>
public sealed class CredentialIpcPeerCredentialMismatch
{
    /// <summary>Gets the offending peer information, if available.</summary>
    public required PeerInfo? Peer { get; init; }

    /// <summary>Gets a short reason describing why the peer was rejected.</summary>
    public required string Reason { get; init; }

    /// <summary>Gets the UTC wall-clock time at which the mismatch was detected.</summary>
    public required DateTimeOffset At { get; init; }
}
