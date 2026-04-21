// <copyright file="OutputStream.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Output;

/// <summary>Identifies which standard stream a chunk came from.</summary>
public enum OutputStream
{
    /// <summary>Standard output stream.</summary>
    StdOut,

    /// <summary>Standard error stream.</summary>
    StdErr,
}
