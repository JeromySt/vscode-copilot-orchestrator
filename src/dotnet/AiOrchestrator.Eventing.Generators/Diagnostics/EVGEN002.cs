// <copyright file="EVGEN002.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace AiOrchestrator.Eventing.Generators.Diagnostics;

/// <summary>EVGEN002: Two or more types declare the same <c>[EventV(name, version)]</c>.</summary>
internal static class EVGEN002
{
    /// <summary>Diagnostic id.</summary>
    public const string Id = "EVGEN002";

    /// <summary>The diagnostic descriptor.</summary>
    public static readonly DiagnosticDescriptor Descriptor = new(
        id: Id,
        title: "Duplicate event version",
        messageFormat: "Event type '{0}' has more than one type declared at version {1}",
        category: "AiOrchestrator.Eventing",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Each (eventTypeName, version) pair must be declared exactly once.",
        helpLinkUri: "https://aka.ms/aio-eventing/EVGEN002");
}
