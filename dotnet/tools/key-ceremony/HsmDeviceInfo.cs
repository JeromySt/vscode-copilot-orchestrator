// <copyright file="HsmDeviceInfo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Tools.KeyCeremony;

#pragma warning disable CA1819 // Properties should not return arrays — record carries raw key bytes by design.

/// <summary>Public information about a connected HSM device.</summary>
public sealed record HsmDeviceInfo
{
    /// <summary>Gets the device serial reported by the HSM.</summary>
    public required string DeviceSerial { get; init; }

    /// <summary>Gets the firmware version reported by the HSM.</summary>
    public required string FirmwareVersion { get; init; }

    /// <summary>Gets the Ed25519 public key associated with the operator's signing key.</summary>
    public required byte[] PublicKey { get; init; }

    /// <summary>Gets the HSM-side identifier of the signing key.</summary>
    public required string KeyId { get; init; }
}

#pragma warning restore CA1819
