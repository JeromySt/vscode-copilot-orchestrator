// <copyright file="FilePermissions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Io;

/// <summary>Represents POSIX-style file permissions encoded as an octal mode integer.</summary>
/// <param name="OctalMode">The octal permission mode (e.g., <c>0644</c>, <c>0755</c>).</param>
public readonly record struct FilePermissions(int OctalMode);
