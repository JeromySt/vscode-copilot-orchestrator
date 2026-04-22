// <copyright file="EVGEN001.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace AiOrchestrator.Eventing.Generators.Diagnostics;

/// <summary>EVGEN001: A required <c>IEventMigration&lt;V_i, V_{i+1}&gt;</c> implementation is missing from the compilation.</summary>
internal static class EVGEN001
{
    /// <summary>Diagnostic id.</summary>
    public const string Id = "EVGEN001";

    /// <summary>The diagnostic descriptor.</summary>
    public static readonly DiagnosticDescriptor Descriptor = new(
        id: Id,
        title: "Missing IEventMigration implementation",
        messageFormat: "Event type '{0}' is missing a public IEventMigration<{1}, {2}> implementation between versions {3} and {4}",
        category: "AiOrchestrator.Eventing",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Every adjacent (N, N+1) pair of [EventV]-attributed types must have a public IEventMigration implementation.",
        helpLinkUri: "https://aka.ms/aio-eventing/EVGEN001");
}
