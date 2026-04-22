// <copyright file="BuildKeysOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Configuration.Options;

/// <summary>Build-key manifest options.</summary>
[OptionsValidator]
public sealed partial class BuildKeysOptions : IValidateOptions<BuildKeysOptions>
{
    /// <summary>Gets or sets the number of days after which a build key is considered stale.</summary>
    [Range(1, 365)]
    public int StaleAfterDays { get; set; } = 30;

    /// <summary>Gets or sets the URL of the build-key manifest document.</summary>
    [Required]
    #pragma warning disable CA1056
    public string ManifestUrl { get; set; } = "https://aka.ms/aio-build-keys.json";
}
