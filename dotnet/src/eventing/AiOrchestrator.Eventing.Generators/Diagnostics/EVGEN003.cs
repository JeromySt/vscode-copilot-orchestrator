// <copyright file="EVGEN003.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace AiOrchestrator.Eventing.Generators.Diagnostics;

/// <summary>EVGEN003: An event type's declared versions are not a contiguous sequence starting at 1.</summary>
internal static class EVGEN003
{
    /// <summary>Diagnostic id.</summary>
    public const string Id = "EVGEN003";

    /// <summary>The diagnostic descriptor.</summary>
    public static readonly DiagnosticDescriptor Descriptor = new(
        id: Id,
        title: "Gap in event version sequence",
        messageFormat: "Event type '{0}' has a gap in its version sequence; expected version {1} but the next declared version is {2}",
        category: "AiOrchestrator.Eventing",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Event versions must be a contiguous sequence starting at 1: {1, 2, ..., N}.",
        helpLinkUri: "https://aka.ms/aio-eventing/EVGEN003");
}
