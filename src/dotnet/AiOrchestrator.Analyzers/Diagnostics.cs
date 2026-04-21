// <copyright file="Diagnostics.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace AiOrchestrator.Analyzers;

/// <summary>
/// Centralized diagnostic descriptor constants for all OE-prefixed rules.
/// Other projects may reference these IDs in <c>[SuppressMessage]</c> attributes
/// when a suppression is absolutely necessary.
/// </summary>
public static class Diagnostics
{
    private const string Category = "AiOrchestrator";

    /// <summary>OE0001 — Public type or member is missing an XML documentation comment.</summary>
    public static readonly DiagnosticDescriptor OE0001 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0001,
        title: "Public type or member missing XML doc comment",
        messageFormat: "Public {0} '{1}' is missing an XML documentation comment",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Every public type and member must have an XML documentation comment to keep the public API self-documented.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0001.md");

    /// <summary>OE0002 — Direct instantiation of a DI-registered type outside the Composition project.</summary>
    public static readonly DiagnosticDescriptor OE0002 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0002,
        title: "Direct instantiation of DI-managed type outside Composition",
        messageFormat: "Do not use 'new {0}()' outside AiOrchestrator.Composition; resolve it from the DI container",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Types registered in the DI container must never be directly instantiated outside the Composition project.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0002.md");

    /// <summary>OE0003 — Reference to Microsoft.VisualStudio namespace outside the extension transport project.</summary>
    public static readonly DiagnosticDescriptor OE0003 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0003,
        title: "Microsoft.VisualStudio reference outside extension transport",
        messageFormat: "Do not reference the 'Microsoft.VisualStudio' namespace outside the VS extension transport project",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Microsoft.VisualStudio APIs are only allowed in the VS extension transport project.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0003.md");

    /// <summary>OE0004 — Use of System.IO.File or System.IO.Directory outside AiOrchestrator.FileSystem.</summary>
    public static readonly DiagnosticDescriptor OE0004 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0004,
        title: "System.IO.File/Directory used outside FileSystem project",
        messageFormat: "Do not use '{0}' directly; use IFileSystem instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Direct file system access via System.IO.File or System.IO.Directory is only allowed in the AiOrchestrator.FileSystem project.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0004.md");

    /// <summary>OE0005 — Use of System.Diagnostics.Process outside AiOrchestrator.Process.</summary>
    public static readonly DiagnosticDescriptor OE0005 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0005,
        title: "System.Diagnostics.Process used outside Process project",
        messageFormat: "Do not use 'System.Diagnostics.Process' directly; use IProcessSpawner instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Process management is only allowed in the AiOrchestrator.Process project.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0005.md");

    /// <summary>OE0006 — Use of LibGit2Sharp or git shell-out outside AiOrchestrator.Git.</summary>
    public static readonly DiagnosticDescriptor OE0006 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0006,
        title: "LibGit2Sharp or git shell-out used outside Git project",
        messageFormat: "Do not use LibGit2Sharp or git shell commands outside AiOrchestrator.Git; use IGitOperations instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Git operations are only allowed in the AiOrchestrator.Git project.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0006.md");

    /// <summary>OE0007 — Async method is missing a CancellationToken parameter.</summary>
    public static readonly DiagnosticDescriptor OE0007 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0007,
        title: "Async method missing CancellationToken parameter",
        messageFormat: "Async method '{0}' must accept a CancellationToken parameter",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Every async method must accept a CancellationToken to support cooperative cancellation.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0007.md");

    /// <summary>OE0008 — async void method (async void is not allowed except in event handlers).</summary>
    public static readonly DiagnosticDescriptor OE0008 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0008,
        title: "async void method",
        messageFormat: "Method '{0}' is 'async void'; use 'async Task' instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "async void methods swallow exceptions. Use async Task instead, except for event handlers marked [AsyncEventHandler].",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0008.md");

    /// <summary>OE0009 — [DllImport] used instead of [LibraryImport].</summary>
    public static readonly DiagnosticDescriptor OE0009 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0009,
        title: "[DllImport] used instead of [LibraryImport]",
        messageFormat: "Replace [DllImport] with [LibraryImport] for source-generated P/Invoke",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "[LibraryImport] generates efficient source-generated P/Invoke marshalling, unlike [DllImport] which uses runtime reflection.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0009.md");

    /// <summary>OE0010 — Banned time/clock API usage.</summary>
    public static readonly DiagnosticDescriptor OE0010 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0010,
        title: "Banned time/clock API",
        messageFormat: "Do not use '{0}'; use IClock instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "DateTime.UtcNow, DateTime.Now, Environment.TickCount, and Thread.Sleep are banned. Use IClock / IDelayProvider abstractions.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0010.md");

    /// <summary>OE0011 — Synchronous System.IO.File read/write API usage.</summary>
    public static readonly DiagnosticDescriptor OE0011 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0011,
        title: "Synchronous File I/O API",
        messageFormat: "Do not use synchronous '{0}'; use async IFileSystem methods instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Synchronous file I/O methods block threads. Use the async IFileSystem abstraction.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0011.md");

    /// <summary>OE0012 — Process.Start usage.</summary>
    public static readonly DiagnosticDescriptor OE0012 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0012,
        title: "Process.Start is banned",
        messageFormat: "Do not use 'Process.Start'; use IProcessSpawner instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Process.Start is banned. Use IProcessSpawner for spawning child processes.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0012.md");

    /// <summary>OE0020 — Public method has dynamic or object parameter type.</summary>
    public static readonly DiagnosticDescriptor OE0020 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0020,
        title: "Public method has dynamic or object parameter",
        messageFormat: "Public method '{0}' has parameter '{1}' of type '{2}'; use a specific type or generic",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Public methods must not use 'dynamic' or 'object' as parameter types; use specific types or generics.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0020.md");

    /// <summary>OE0030 — Test method missing [ContractTest] attribute.</summary>
    public static readonly DiagnosticDescriptor OE0030 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0030,
        title: "Test method missing [ContractTest] attribute",
        messageFormat: "Test method '{0}' is missing a [ContractTest(\"RULE-ID\")] attribute",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "All test methods in tests/dotnet/** must carry [ContractTest(\"RULE-ID\")] to link them to acceptance criteria.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0030.md");

    /// <summary>OE0040 — Reflection-based JSON serialization detected.</summary>
    public static readonly DiagnosticDescriptor OE0040 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0040,
        title: "Reflection-based JSON serialization",
        messageFormat: "'{0}' uses reflection-based serialization; pass a JsonSerializerContext for source-generated serialization",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "JsonSerializer.Serialize/Deserialize without a JsonSerializerContext use reflection, which is incompatible with trimming and NativeAOT.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0040.md");

    /// <summary>OE0046 — Logger call uses string interpolation in the message template.</summary>
    public static readonly DiagnosticDescriptor OE0046 = new DiagnosticDescriptor(
        id: DiagnosticIds.OE0046,
        title: "Logger message template uses string interpolation",
        messageFormat: "Logger call '{0}' uses string interpolation; use structured logging with named placeholders instead",
        category: Category,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "String interpolation in logger message templates defeats structured logging. Use named placeholders like {PropertyName} and pass values as arguments.",
        helpLinkUri: "https://github.com/AiOrchestrator/docs/OE0046.md");
}
