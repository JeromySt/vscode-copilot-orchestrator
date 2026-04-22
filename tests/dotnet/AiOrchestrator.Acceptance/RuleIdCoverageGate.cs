// <copyright file="RuleIdCoverageGate.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Acceptance;

/// <summary>
/// Solution-wide coverage gate: asserts that every rule id named in §§3.27–3.33 of the design
/// doc has a corresponding <c>[ContractTest("&lt;RULE-ID&gt;")]</c> attribute somewhere in the test tree.
/// </summary>
public sealed class RuleIdCoverageGate
{
    private readonly IFileSystem fs;

    /// <summary>Initializes a new instance of the <see cref="RuleIdCoverageGate"/> class.</summary>
    /// <param name="fs">The filesystem abstraction (job 009).</param>
    public RuleIdCoverageGate(IFileSystem fs)
    {
        ArgumentNullException.ThrowIfNull(fs);
        this.fs = fs;
    }

    /// <summary>Runs the coverage gate against the given design doc and solution root.</summary>
    /// <param name="designDocPath">Absolute path to <c>docs/DOTNET_CORE_REARCHITECTURE_PLAN.md</c>.</param>
    /// <param name="solutionRoot">Absolute path to the repository root.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A populated <see cref="CoverageReport"/>.</returns>
    public async ValueTask<CoverageReport> RunAsync(
        AbsolutePath designDocPath,
        AbsolutePath solutionRoot,
        CancellationToken ct)
    {
        string markdown = await this.fs.ReadAllTextAsync(designDocPath, ct).ConfigureAwait(false);

        var extractor = new DesignDocRuleExtractor();
        ImmutableArray<string> allRules = extractor.Extract(markdown);

        var scanner = new ContractTestScanner(this.fs);
        ImmutableArray<string> coveredAttrIds = await scanner.ScanAsync(solutionRoot, ct).ConfigureAwait(false);

        var ruleSet = new HashSet<string>(allRules, StringComparer.Ordinal);
        var coveredSet = new HashSet<string>(coveredAttrIds, StringComparer.Ordinal);

        var covered = ImmutableArray.CreateBuilder<string>();
        var uncovered = ImmutableArray.CreateBuilder<string>();
        foreach (string id in allRules)
        {
            if (coveredSet.Contains(id))
            {
                covered.Add(id);
            }
            else
            {
                uncovered.Add(id);
            }
        }

        var extra = ImmutableArray.CreateBuilder<string>();
        foreach (string id in coveredAttrIds)
        {
            if (!ruleSet.Contains(id))
            {
                extra.Add(id);
            }
        }

        return new CoverageReport
        {
            AllRuleIds = allRules,
            CoveredRuleIds = covered.ToImmutable(),
            UncoveredRuleIds = uncovered.ToImmutable(),
            ExtraTestRuleIds = extra.ToImmutable(),
        };
    }
}
