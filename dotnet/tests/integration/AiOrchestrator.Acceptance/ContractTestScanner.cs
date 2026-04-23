// <copyright file="ContractTestScanner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Acceptance;

/// <summary>
/// Walks every <c>.cs</c> file under <c>dotnet/tests/</c> and returns the literal id strings
/// passed to <c>[ContractTest("...")]</c> attributes.
/// </summary>
internal sealed partial class ContractTestScanner
{
    private readonly IFileSystem fs;

    public ContractTestScanner(IFileSystem fs)
    {
        ArgumentNullException.ThrowIfNull(fs);
        this.fs = fs;
    }

    public async ValueTask<ImmutableArray<string>> ScanAsync(AbsolutePath solutionRoot, CancellationToken ct)
    {
        string testsRoot = Path.Combine(solutionRoot.Value, "dotnet", "tests");
        if (!Directory.Exists(testsRoot))
        {
            return ImmutableArray<string>.Empty;
        }

        var ids = new SortedSet<string>(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(testsRoot, "*.cs", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            var p = new AbsolutePath(file);
            string content = await this.fs.ReadAllTextAsync(p, ct).ConfigureAwait(false);
            foreach (Match m in AttributePattern().Matches(content))
            {
                ids.Add(m.Groups[1].Value);
            }
        }

        return [.. ids];
    }

    [GeneratedRegex(@"\[\s*ContractTest\s*\(\s*""([^""]+)""\s*\)\s*\]", RegexOptions.CultureInvariant)]
    private static partial Regex AttributePattern();
}
