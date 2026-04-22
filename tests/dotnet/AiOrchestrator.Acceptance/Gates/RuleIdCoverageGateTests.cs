// <copyright file="RuleIdCoverageGateTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace AiOrchestrator.Acceptance.Gates;

/// <summary>Tests for the solution-wide rule-id coverage gate (job 041).</summary>
public sealed class RuleIdCoverageGateTests
{
    private readonly ITestOutputHelper output;

    public RuleIdCoverageGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    private static (RuleIdCoverageGate gate, AbsolutePath designDoc, AbsolutePath repoRoot) BuildGate()
    {
        string repo = RepoRoot.Find();
        IFileSystem fs = new DirectFileSystem();
        return (
            new RuleIdCoverageGate(fs),
            new AbsolutePath(Path.Combine(repo, "docs", "DOTNET_CORE_REARCHITECTURE_PLAN.md")),
            new AbsolutePath(repo));
    }

    [Fact]
    [ContractTest("ACCEPT-COVERAGE")]
    public async Task RULE_COVERAGE_GATE_AllNamedRulesHaveTests()
    {
        (RuleIdCoverageGate gate, AbsolutePath doc, AbsolutePath repo) = BuildGate();
        CoverageReport report = await gate.RunAsync(doc, repo, CancellationToken.None);

        if (!report.UncoveredRuleIds.IsEmpty)
        {
            this.output.WriteLine($"Uncovered rule ids ({report.UncoveredRuleIds.Length}):");
            foreach (string id in report.UncoveredRuleIds)
            {
                this.output.WriteLine("  " + id);
            }
        }

        report.AllRuleIds.Should().NotBeEmpty("design doc §§3.27–3.33 must contain rule ids");
        report.Ok.Should().BeTrue(
            "every rule id named in §§3.27–3.33 must have a [ContractTest(\"<ID>\")] attribute somewhere under tests/dotnet/");
        report.UncoveredRuleIds.Should().BeEmpty();
    }

    [Fact]
    [ContractTest("ACCEPT-COVERAGE-EXTRA")]
    public async Task RULE_COVERAGE_REPORT_LogsExtraRules()
    {
        (RuleIdCoverageGate gate, AbsolutePath doc, AbsolutePath repo) = BuildGate();
        CoverageReport report = await gate.RunAsync(doc, repo, CancellationToken.None);

        // INV-4: Extra rule ids (tests for ids not in §§3.27–3.33) are REPORTED but DO NOT
        // fail the gate — this allows test-driven exploration of new rules before doc updates.
        this.output.WriteLine($"Extra contract-test ids (not in §§3.27–3.33): {report.ExtraTestRuleIds.Length}");
        foreach (string id in report.ExtraTestRuleIds.Take(50))
        {
            this.output.WriteLine("  " + id);
        }

        report.ExtraTestRuleIds.Should().NotBeNull();
        report.Ok.Should().Be(report.UncoveredRuleIds.IsEmpty);
    }

    [Fact]
    [ContractTest("ACCEPT-EXTRACT-REGEX")]
    public void DesignDocRuleExtractor_OnlyMatchesIdsWithinSection()
    {
        const string md = """
            ## 3.26 Earlier section
            DROP-1 is not a rule.
            ## 3.27 Performance
            FOO-BAR-1 should match.
            ## 3.30 DAG Core
            BAZ-2 should match too.
            ## 3.34 Later section
            QUX-9 must NOT match.
            """;

        var extractor = new DesignDocRuleExtractor();
        var ids = extractor.Extract(md);

        ids.Should().Contain("FOO-BAR-1");
        ids.Should().Contain("BAZ-2");
        ids.Should().NotContain("DROP-1");
        ids.Should().NotContain("QUX-9");
    }

    [Fact]
    [ContractTest("ACCEPT-SCANNER-LITERAL")]
    public async Task ContractTestScanner_ReturnsLiteralIds()
    {
        string repo = RepoRoot.Find();
        IFileSystem fs = new DirectFileSystem();

        var scanner = new ContractTestScanner(fs);
        var ids = await scanner.ScanAsync(new AbsolutePath(repo), CancellationToken.None);

        ids.Should().NotBeEmpty();
        ids.Should().Contain("ACCEPT-COVERAGE");
        ids.Should().Contain("ACCEPT-COVERAGE-EXTRA");
    }
}
