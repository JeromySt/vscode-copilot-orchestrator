// <copyright file="INetworkProbe.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Linq;
using System.Net.NetworkInformation;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Probe for active non-loopback network interfaces (used by INV-1 air-gap check).</summary>
public interface INetworkProbe
{
    /// <summary>Gets a value indicating whether any non-loopback interface is currently up.</summary>
    bool NetworkUp { get; }
}

/// <summary>Default <see cref="INetworkProbe"/> implementation backed by the OS.</summary>
public sealed class DefaultNetworkProbe : INetworkProbe
{
    /// <inheritdoc/>
    public bool NetworkUp => NetworkInterface
        .GetAllNetworkInterfaces()
        .Any(n => n.OperationalStatus == OperationalStatus.Up
            && n.NetworkInterfaceType != NetworkInterfaceType.Loopback);
}
