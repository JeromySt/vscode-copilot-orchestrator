// <copyright file="WorkflowContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
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
        Assert.True(File.Exists(path), $"pr.yml must exist at {path}");
        var c = File.ReadAllText(path);

        Assert.Contains("dotnet restore", c);
        Assert.Contains("dotnet build", c);
        Assert.Contains("-warnaserror", c);
        Assert.Contains("dotnet test", c);
        Assert.Contains("--collect:\"XPlat Code Coverage\"", c);
        Assert.Contains("check-coverage.ps1", c);
        Assert.Contains("check-analyzers.ps1", c);
        Assert.Contains("check-banned-apis.ps1", c);
        Assert.Contains("check-public-api.ps1", c);
        Assert.Contains("check-composition.ps1", c);
        Assert.Contains("codeql", c.ToLowerInvariant());
    }

    [Fact]
    [ContractTest("CI-MAIN")]
    public void CI_MAIN_WorkflowSignsPackages()
    {
        var path = Path.Combine(WorkflowsDir(), "main.yml");
        Assert.True(File.Exists(path));
        var c = File.ReadAllText(path);

        Assert.Contains("dotnet pack", c);
        Assert.True(c.Contains("dotnet nuget sign") || c.Contains("nuget sign"), "main.yml must sign nuget packages");
        Assert.Contains("--timestamper", c);
    }

    [Fact]
    [ContractTest("CI-RELEASE")]
    public void CI_RELEASE_RequiresSignedManifestInput()
    {
        var path = Path.Combine(WorkflowsDir(), "release.yml");
        Assert.True(File.Exists(path));
        var c = File.ReadAllText(path);

        Assert.Contains("workflow_dispatch", c);
        // Must NOT trigger on push to main.
        Assert.DoesNotMatch(@"on:\s*\r?\n\s*push:\s*\r?\n\s*branches:\s*\[\s*main", c);
        var hasInput = c.Contains("signed_manifest_url") || c.Contains("signed_manifest_path");
        Assert.True(hasInput, "release.yml must accept signed_manifest_url or signed_manifest_path input");
        var refsManifest = c.Contains("SignedReleaseManifest")
            || c.Contains("signed-manifest")
            || c.Contains("release-manifest.signed");
        Assert.True(refsManifest, "release.yml must reference signed manifest verification");
    }

    [Fact]
    [ContractTest("CI-PIN")]
    public void CI_ALL_ActionsPinnedBySha()
    {
        var dir = WorkflowsDir();
        var files = Directory.GetFiles(dir, "*.yml");
        Assert.NotEmpty(files);

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

        Assert.Empty(violations); // every workflow uses: must pin to a 40-hex SHA
    }

    [Fact]
    [ContractTest("CI-SKEW")]
    public void CI_RELEASE_RefusesIfSkewMismatch()
    {
        var path = Path.Combine(WorkflowsDir(), "release.yml");
        Assert.True(File.Exists(path));
        var c = File.ReadAllText(path);
        Assert.Contains("SkewManifest", c);
        Assert.Contains("TrustedAuditPubKeys", c);
    }
}
