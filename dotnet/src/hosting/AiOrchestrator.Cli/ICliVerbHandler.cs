// <copyright file="ICliVerbHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.CommandLine;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli;

/// <summary>
/// Contract implemented by every CLI verb. A verb is a terminal (leaf) command
/// such as <c>plan create</c> or <c>daemon start</c>.
/// </summary>
public interface ICliVerbHandler
{
    /// <summary>Gets the space-delimited verb path, e.g. <c>"plan create"</c>.</summary>
    string VerbPath { get; }

    /// <summary>Creates the <see cref="Command"/> tree for this verb (including options).</summary>
    /// <returns>The constructed <see cref="Command"/>.</returns>
    Command Build();

    /// <summary>Executes the verb.</summary>
    /// <param name="result">The parse result produced for this verb invocation.</param>
    /// <param name="ct">A cancellation token.</param>
    /// <returns>The CLI exit code.</returns>
    Task<int> InvokeAsync(ParseResult result, CancellationToken ct);
}
