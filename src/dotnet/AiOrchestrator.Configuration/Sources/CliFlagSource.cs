// <copyright file="CliFlagSource.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Configuration.CommandLine;

namespace AiOrchestrator.Configuration.Sources;

/// <summary>
/// Adds command-line arguments as a configuration source with the highest in-process precedence
/// (below in-memory overrides). Arguments follow the standard <c>--Key=Value</c> and
/// <c>--Key Value</c> conventions supported by <see cref="CommandLineConfigurationProvider" />.
/// </summary>
public sealed class CliFlagSource : IConfigurationSource
{
    private readonly IEnumerable<string>? args;

    /// <summary>Initializes a new instance of the <see cref="CliFlagSource"/> class.</summary>
    /// <param name="args">
    /// The command-line tokens to parse. When <see langword="null" />, the source contributes no values.
    /// </param>
    public CliFlagSource(IEnumerable<string>? args)
    {
        this.args = args;
    }

    /// <inheritdoc />
    public IConfigurationProvider Build(IConfigurationBuilder builder)
    {
        return new CommandLineConfigurationProvider(this.args ?? []);
    }
}
