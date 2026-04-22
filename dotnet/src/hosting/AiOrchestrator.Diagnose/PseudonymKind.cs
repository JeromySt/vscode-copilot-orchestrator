// <copyright file="PseudonymKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Diagnose;

/// <summary>Categorizes the type of identifier being pseudonymized.</summary>
public enum PseudonymKind
{
    /// <summary>A user name.</summary>
    UserName,

    /// <summary>A host name.</summary>
    Hostname,

    /// <summary>A repository URL.</summary>
    RepoUrl,

    /// <summary>A filesystem path.</summary>
    FilePath,

    /// <summary>An email address.</summary>
    EmailAddress,

    /// <summary>An IP address.</summary>
    IpAddress,
}
