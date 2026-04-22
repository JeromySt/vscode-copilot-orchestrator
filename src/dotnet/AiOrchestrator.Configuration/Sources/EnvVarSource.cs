// <copyright file="EnvVarSource.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Configuration.EnvironmentVariables;

namespace AiOrchestrator.Configuration.Sources;

/// <summary>
/// Adds environment variables with the <c>AIO_</c> prefix as a configuration source.
/// Double-underscore (<c>__</c>) in variable names is translated to the colon (<c>:</c>)
/// hierarchy separator, e.g. <c>AIO_Scheduler__Channel__Capacity</c> maps to
/// <c>Scheduler:Channel:Capacity</c>.
/// </summary>
public sealed class EnvVarSource : IConfigurationSource
{
    /// <summary>The environment-variable prefix recognised by this source.</summary>
    public const string Prefix = "AIO_";

    /// <inheritdoc />
    public IConfigurationProvider Build(IConfigurationBuilder builder)
    {
        return new EnvironmentVariablesConfigurationProvider(Prefix);
    }
}
