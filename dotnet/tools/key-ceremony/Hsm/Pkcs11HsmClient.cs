// <copyright file="Pkcs11HsmClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Tools.KeyCeremony.Hsm;

/// <summary>
/// PKCS#11-backed HSM client. Wire the actual SDK (e.g., Pkcs11Interop) before production use.
/// </summary>
internal sealed class Pkcs11HsmClient : IHsmClient
{
    /// <inheritdoc/>
    public ValueTask<HsmDeviceInfo> ConnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => throw new NotImplementedException("Wire PKCS#11 SDK before production use (operator: " + operator_.Value + ").");

    /// <inheritdoc/>
    public ValueTask<byte[]> SignAsync(HsmOperatorId operator_, byte[] payloadHash, CancellationToken ct)
        => throw new NotImplementedException("Wire PKCS#11 SDK before production use.");

    /// <inheritdoc/>
    public ValueTask DisconnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => ValueTask.CompletedTask;
}
