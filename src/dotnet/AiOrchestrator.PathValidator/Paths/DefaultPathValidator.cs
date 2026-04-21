// <copyright file="DefaultPathValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.PathValidator.Paths;

/// <summary>
/// Default implementation of <see cref="IPathValidator"/> enforcing path traversal prevention,
/// allowlist containment, and platform-specific reserved name rejection.
/// </summary>
public sealed class DefaultPathValidator : IPathValidator
{
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    private readonly IEnumerable<string> _allowedRoots;

    /// <summary>
    /// Initializes a new instance of the <see cref="DefaultPathValidator"/> class.
    /// </summary>
    /// <param name="allowedRoots">The set of allowed root directories.</param>
    public DefaultPathValidator(IEnumerable<string> allowedRoots)
    {
        _allowedRoots = allowedRoots ?? throw new ArgumentNullException(nameof(allowedRoots));
    }

    /// <summary>
    /// Validates a string path (non-model version for testing).
    /// </summary>
    public void AssertSafe(string path, string allowedRoot)
    {
        if (path == null) throw new ArgumentNullException(nameof(path));
        if (allowedRoot == null) throw new ArgumentNullException(nameof(allowedRoot));

        // Must be fully qualified
        if (!Path.IsPathRooted(path))
        {
            throw new UnauthorizedAccessException($"Path must be fully qualified: {path}");
        }

        // Normalize paths
        var normalized = Path.GetFullPath(path);
        var normalizedRoot = Path.GetFullPath(allowedRoot);

        // Reject NUL bytes and ASCII control characters
        if (normalized.Any(c => c == '\0' || char.IsControl(c)))
        {
            throw new UnauthorizedAccessException("Path contains invalid characters (NUL or control characters)");
        }

        if (normalizedRoot.Any(c => c == '\0' || char.IsControl(c)))
        {
            throw new UnauthorizedAccessException("Allowed root contains invalid characters (NUL or control characters)");
        }

        // Detect traversal attempts (.. after normalization)
        if (normalized.Contains(".."))
        {
            throw new UnauthorizedAccessException($"Path contains traversal sequence: {path}");
        }

        // Containment check: path must be strictly within allowed root
        var pathStartsWithRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? normalized.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)
            : normalized.StartsWith(normalizedRoot, StringComparison.Ordinal);

        if (!pathStartsWithRoot || (normalized.Length > normalizedRoot.Length && 
            normalized[normalizedRoot.Length] != Path.DirectorySeparatorChar))
        {
            throw new UnauthorizedAccessException(
                $"Path escapes allowed root. Path: {path}, Root: {allowedRoot}");
        }

        // Reject reserved Windows device names
        RejectReservedNames(normalized);
    }

    /// <inheritdoc/>
    public void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot)
    {
        AssertSafe(path.Value, allowedRoot.Value);
    }

    /// <inheritdoc/>
    public async ValueTask<Stream> OpenReadUnderRootAsync(
        AbsolutePath allowedRoot,
        RelativePath relative,
        CancellationToken ct)
    {
        // Construct the full path by combining root and relative
        var fullPath = allowedRoot.Combine(relative);

        // Validate it's safe
        AssertSafe(fullPath, allowedRoot);

        // Open the file for reading
        return new FileStream(
            fullPath.Value,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            useAsync: true);
    }

    /// <summary>
    /// Opens a read-only stream over a path (string version for testing).
    /// </summary>
    public async ValueTask<Stream> OpenReadUnderRootAsync(
        string allowedRoot,
        string relativePath,
        CancellationToken ct)
    {
        if (allowedRoot == null) throw new ArgumentNullException(nameof(allowedRoot));
        if (relativePath == null) throw new ArgumentNullException(nameof(relativePath));

        // Construct the full path by combining root and relative
        var fullPath = Path.Combine(allowedRoot, relativePath);

        // Validate it's safe
        AssertSafe(fullPath, allowedRoot);

        // Open the file for reading
        return new FileStream(
            fullPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 4096,
            useAsync: true);
    }

    private static void RejectReservedNames(string normalizedPath)
    {
        var parts = normalizedPath.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, 
            StringSplitOptions.RemoveEmptyEntries);

        foreach (var part in parts)
        {
            // Extract the name part without stream specifier (e.g., "CON:stream" -> "CON")
            var name = part.Split(':')[0];

            if (ReservedNames.Contains(name))
            {
                throw new UnauthorizedAccessException(
                    $"Path component is a reserved device name: {part}");
            }
        }
    }
}
