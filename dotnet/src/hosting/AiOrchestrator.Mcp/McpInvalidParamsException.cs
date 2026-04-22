// <copyright file="McpInvalidParamsException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Mcp;

/// <summary>Exception raised when tool parameters fail schema validation.</summary>
internal sealed class McpInvalidParamsException : Exception
{
    public McpInvalidParamsException(string message)
        : base(message)
    {
    }

    public McpInvalidParamsException()
    {
    }

    public McpInvalidParamsException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
