// <copyright file="YubiHsmClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Tools.KeyCeremony.Hsm;

/// <summary>
/// YubiHSM-backed client. Wire the YubiHSM SDK (yubihsm-shell / Yubico.YubiHSM) before production use.
/// </summary>
[ExcludeFromCodeCoverage]
internal sealed class YubiHsmClient : IHsmClient
{
    /// <inheritdoc/>
    public ValueTask<HsmDeviceInfo> ConnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => throw new NotImplementedException("Wire YubiHSM SDK before production use (operator: " + operator_.Value + ").");

    /// <inheritdoc/>
    public ValueTask<byte[]> SignAsync(HsmOperatorId operator_, byte[] payloadHash, CancellationToken ct)
        => throw new NotImplementedException("Wire YubiHSM SDK before production use.");

    /// <inheritdoc/>
    public ValueTask DisconnectAsync(HsmOperatorId operator_, CancellationToken ct)
        => ValueTask.CompletedTask;
}
