// <copyright file="WorkflowContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Tools.KeyCeremony.Tests;

public sealed class WorkflowContractTests
{
    private static string WorkflowsDir() => Path.Combine(RepoRoot.Find(), ".github", "workflows");

    [Fact]
    [ContractTest("CI-PR")]
    public void CI_PR_WorkflowExecutesAllGates()
    {
        var path = Path.Combine(WorkflowsDir(), "pr.yml");
        File.Exists(path).Should().BeTrue($"pr.yml must exist at {path}");
        var c = File.ReadAllText(path);

        c.Should().Contain("dotnet restore");
        c.Should().Contain("dotnet build");
        c.Should().Contain("-warnaserror");
        c.Should().Contain("dotnet test");
        c.Should().Contain("--collect:\"XPlat Code Coverage\"");
        c.Should().Contain("check-coverage.ps1");
        c.Should().Contain("check-analyzers.ps1");
        c.Should().Contain("check-banned-apis.ps1");
        c.Should().Contain("check-public-api.ps1");
        c.Should().Contain("check-composition.ps1");
        c.ToLowerInvariant().Should().Contain("codeql");
    }

    [Fact]
    [ContractTest("CI-MAIN")]
    public void CI_MAIN_WorkflowSignsPackages()
    {
        var path = Path.Combine(WorkflowsDir(), "main.yml");
        File.Exists(path).Should().BeTrue();
        var c = File.ReadAllText(path);

        c.Should().Contain("dotnet pack");
        (c.Contains("dotnet nuget sign") || c.Contains("nuget sign"))
            .Should().BeTrue("main.yml must sign nuget packages");
        c.Should().Contain("--timestamper", "RFC 3161 timestamping is required");
    }

    [Fact]
    [ContractTest("CI-RELEASE")]
    public void CI_RELEASE_RequiresSignedManifestInput()
    {
        var path = Path.Combine(WorkflowsDir(), "release.yml");
        File.Exists(path).Should().BeTrue();
        var c = File.ReadAllText(path);

        c.Should().Contain("workflow_dispatch");
        // Must NOT trigger on push to main.
        c.Should().NotMatch(new Regex(@"on:\s*\r?\n\s*push:\s*\r?\n\s*branches:\s*\[\s*main", RegexOptions.None).ToString());
        var hasInput = c.Contains("signed_manifest_url") || c.Contains("signed_manifest_path");
        hasInput.Should().BeTrue("release.yml must accept signed_manifest_url or signed_manifest_path input");
        var refsManifest = c.Contains("SignedReleaseManifest")
            || c.Contains("signed-manifest")
            || c.Contains("release-manifest.signed");
        refsManifest.Should().BeTrue("release.yml must reference signed manifest verification");
    }

    [Fact]
    [ContractTest("CI-PIN")]
    public void CI_ALL_ActionsPinnedBySha()
    {
        var dir = WorkflowsDir();
        var files = Directory.GetFiles(dir, "*.yml");
        files.Should().NotBeEmpty();

        var usesRegex = new Regex(@"^\s*-?\s*uses:\s*([^\s#]+)", RegexOptions.Multiline);
        var pinnedRegex = new Regex(@"@[0-9a-fA-F]{40}$");
        var violations = new System.Collections.Generic.List<string>();
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            foreach (Match m in usesRegex.Matches(text))
            {
                var refStr = m.Groups[1].Value.Trim();
                if (!pinnedRegex.IsMatch(refStr))
                {
                    violations.Add($"{Path.GetFileName(file)}: '{refStr}' not pinned by SHA");
                }
            }
        }

        violations.Should().BeEmpty("every workflow uses: must pin to a 40-hex SHA");
    }

    [Fact]
    [ContractTest("CI-SKEW")]
    public void CI_RELEASE_RefusesIfSkewMismatch()
    {
        var path = Path.Combine(WorkflowsDir(), "release.yml");
        File.Exists(path).Should().BeTrue();
        var c = File.ReadAllText(path);
        c.Should().Contain("SkewManifest");
        c.Should().Contain("TrustedAuditPubKeys");
    }
}
