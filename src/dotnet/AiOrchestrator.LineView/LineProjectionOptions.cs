// <copyright file="LineProjectionOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.LineView;

/// <summary>Configuration options for <see cref="LineProjector"/>.</summary>
public struct LineProjectionOptions
{
    /// <summary>Gets or sets the maximum bytes buffered for a single line before forced emission. Default 64 KiB.</summary>
    public int MaxLineBytes { get; set; }

    /// <summary>Gets or sets a value indicating whether ANSI escape sequences should be stripped from emitted lines.</summary>
    public bool StripAnsi { get; set; }
}
