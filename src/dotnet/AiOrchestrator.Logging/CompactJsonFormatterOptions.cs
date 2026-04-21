// <copyright file="CompactJsonFormatterOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Logging.Console;

namespace AiOrchestrator.Logging;

/// <summary>
/// Configuration options for <see cref="CompactJsonFormatter"/>.
/// Inherits <see cref="ConsoleFormatterOptions.IncludeScopes"/> from the base class.
/// </summary>
public sealed class CompactJsonFormatterOptions : ConsoleFormatterOptions
{
    /// <summary>
    /// Gets or sets a value indicating whether the JSON output is indented for readability.
    /// Defaults to <c>false</c> (compact single-line mode).
    /// </summary>
    public bool IndentJson { get; set; }
}
