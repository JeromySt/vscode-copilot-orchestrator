// <copyright file="MountKind.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Io;

/// <summary>Identifies the storage backend technology of a filesystem mount point.</summary>
public enum MountKind
{
    /// <summary>A locally attached block device or virtual filesystem.</summary>
    Local,

    /// <summary>A Network File System (NFS) mount.</summary>
    Nfs,

    /// <summary>A Server Message Block (SMB/CIFS) network share.</summary>
    Smb,

    /// <summary>The mount kind could not be determined.</summary>
    Unknown,
}
