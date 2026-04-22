// <copyright file="EventVersionInfo.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Eventing.Generators;

/// <summary>Discovered metadata for a single <c>[EventV]</c>-attributed type.</summary>
/// <param name="EventTypeName">Stable wire-format discriminator string.</param>
/// <param name="Version">1-based monotonically increasing version number.</param>
/// <param name="FullyQualifiedTypeName">Fully qualified CLR type name (with global:: prefix).</param>
internal sealed record EventVersionInfo(
    string EventTypeName,
    int Version,
    string FullyQualifiedTypeName);
