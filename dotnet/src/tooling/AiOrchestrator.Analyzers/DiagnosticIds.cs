// <copyright file="DiagnosticIds.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Analyzers;

/// <summary>
/// String constants for every diagnostic ID in the OE rule catalog.
/// Reference these constants in <c>[SuppressMessage]</c> attributes instead of
/// hard-coding the strings so that a rename is a single-line change.
/// </summary>
public static class DiagnosticIds
{
    /// <summary>Public type or member missing XML doc comment.</summary>
    public const string OE0001 = "OE0001";

    /// <summary>Direct instantiation of a DI-managed type outside Composition.</summary>
    public const string OE0002 = "OE0002";

    /// <summary>Microsoft.VisualStudio reference outside extension transport.</summary>
    public const string OE0003 = "OE0003";

    /// <summary>System.IO.File or System.IO.Directory used outside FileSystem project.</summary>
    public const string OE0004 = "OE0004";

    /// <summary>System.Diagnostics.Process used outside Process project.</summary>
    public const string OE0005 = "OE0005";

    /// <summary>LibGit2Sharp or git shell-out outside Git project.</summary>
    public const string OE0006 = "OE0006";

    /// <summary>Async method missing a CancellationToken parameter.</summary>
    public const string OE0007 = "OE0007";

    /// <summary>async void method.</summary>
    public const string OE0008 = "OE0008";

    /// <summary>[DllImport] attribute used instead of [LibraryImport].</summary>
    public const string OE0009 = "OE0009";

    /// <summary>Banned time/clock API (DateTime.UtcNow, DateTime.Now, Environment.TickCount, Thread.Sleep).</summary>
    public const string OE0010 = "OE0010";

    /// <summary>Synchronous System.IO.File read/write API.</summary>
    public const string OE0011 = "OE0011";

    /// <summary>Process.Start is banned.</summary>
    public const string OE0012 = "OE0012";

    /// <summary>Public method has a dynamic or object parameter type.</summary>
    public const string OE0020 = "OE0020";

    /// <summary>Test method missing a [ContractTest] attribute.</summary>
    public const string OE0030 = "OE0030";

    /// <summary>Reflection-based JSON serialization.</summary>
    public const string OE0040 = "OE0040";

    /// <summary>Logger message template uses string interpolation.</summary>
    public const string OE0046 = "OE0046";
}
