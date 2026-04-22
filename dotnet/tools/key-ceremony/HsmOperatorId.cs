// <copyright file="HsmOperatorId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Identifies an individual HSM operator participating in the ceremony.</summary>
public readonly record struct HsmOperatorId(string Value);
