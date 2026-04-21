// <copyright file="DefaultPathValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
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

    /// <inheritdoc/>
    public void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot)
    {
        var pathValue = path.Value;
        var rootValue = allowedRoot.Value;

        // Must be fully qualified
        if (!Path.IsPathFullyQualified(pathValue))
        {
            throw new UnauthorizedAccessException($"Path must be fully qualified: {pathValue}");
        }

        // Normalize paths
        var normalized = Path.GetFullPath(pathValue);
        var normalizedRoot = Path.GetFullPath(rootValue);

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
            throw new UnauthorizedAccessException($"Path contains traversal sequence: {pathValue}");
        }

        // Containment check: path must be strictly within allowed root
        var pathStartsWithRoot = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? normalized.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase)
            : normalized.StartsWith(normalizedRoot, StringComparison.Ordinal);

        if (!pathStartsWithRoot || (normalized.Length > normalizedRoot.Length && 
            normalized[normalizedRoot.Length] != Path.DirectorySeparatorChar))
        {
            throw new UnauthorizedAccessException(
                $"Path escapes allowed root. Path: {pathValue}, Root: {rootValue}");
        }

        // Reject reserved Windows device names
        RejectReservedNames(normalized);
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
