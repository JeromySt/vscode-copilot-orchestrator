// <copyright file="IHsmClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Abstraction over an HSM device used during the offline signing ceremony.</summary>
public interface IHsmClient
{
    /// <summary>Connects to the HSM device for the given operator.</summary>
    /// <param name="operator_">The operator identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Information about the connected device.</returns>
    ValueTask<HsmDeviceInfo> ConnectAsync(HsmOperatorId operator_, CancellationToken ct);

    /// <summary>Requests an Ed25519 signature over <paramref name="payloadHash"/> from the operator's HSM.</summary>
    /// <param name="operator_">The operator identifier.</param>
    /// <param name="payloadHash">The SHA-256 digest of the payload to sign.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The raw 64-byte Ed25519 signature.</returns>
    ValueTask<byte[]> SignAsync(HsmOperatorId operator_, byte[] payloadHash, CancellationToken ct);

    /// <summary>Disconnects the HSM for the given operator.</summary>
    /// <param name="operator_">The operator identifier.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the HSM has been disconnected.</returns>
    ValueTask DisconnectAsync(HsmOperatorId operator_, CancellationToken ct);
}
