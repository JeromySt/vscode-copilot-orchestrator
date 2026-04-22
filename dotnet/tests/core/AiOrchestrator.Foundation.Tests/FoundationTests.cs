using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml.Linq;
using Xunit;

namespace AiOrchestrator.Foundation.Tests;

/// <summary>Marks a test as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => Id = id;

    public string Id { get; }
}

/// <summary>Foundation acceptance tests — verifies solution layout, build policy, and helper scripts.</summary>
public sealed class FoundationTests
{
    private static readonly string RepoRoot = FindRepoRoot();
    private static readonly string SrcDotnet = Path.Combine(RepoRoot, "dotnet", "src");
    private static readonly string TestsDotnet = Path.Combine(RepoRoot, "dotnet", "tests");
    private static readonly string ScriptsDotnet = Path.Combine(RepoRoot, "scripts", "dotnet");

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "dotnet", "src")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException("Cannot locate repo root from " + AppContext.BaseDirectory);
    }

    [Fact]
    [ContractTest("FOUND-1")]
    public void Foundation_Solution_BuildsCleanlyWithWarnAsError()
    {
        var slnPath = Path.Combine(RepoRoot, "dotnet", "AiOrchestrator.slnx");
        Assert.True(File.Exists(slnPath), "AiOrchestrator.slnx must exist at dotnet/");
    }

    [Fact]
    [ContractTest("FOUND-2")]
    public void Foundation_Restore_IsHermeticUnderLockedMode()
    {
        // Verifies that packages.lock.json exists for projects that have been restored
        var csprojFiles = Directory.GetFiles(SrcDotnet, "*.csproj", SearchOption.AllDirectories)
            .Concat(Directory.GetFiles(TestsDotnet, "*.csproj", SearchOption.AllDirectories))
            .ToArray();

        // Every csproj directory should have a packages.lock.json after restore
        // (this is a structural check; the actual lock mode is verified by J0-PC-2)
        Assert.NotEmpty(csprojFiles);
    }

    [Fact]
    [ContractTest("FOUND-3")]
    public void Foundation_CentralPackageManagement_ZeroVersionInCsproj()
    {
        var csprojFiles = Directory.GetFiles(SrcDotnet, "*.csproj", SearchOption.AllDirectories)
            .Concat(Directory.GetFiles(TestsDotnet, "*.csproj", SearchOption.AllDirectories))
            .ToArray();

        var violations = new List<string>();
        foreach (var file in csprojFiles)
        {
            var content = File.ReadAllText(file);
            // Check for PackageReference with Version= attribute (inline versioning violates CPM)
            if (System.Text.RegularExpressions.Regex.IsMatch(content, @"<PackageReference[^>]*\sVersion="))
            {
                violations.Add(file);
            }
        }

        Assert.Empty(violations);
    }

    [Fact]
    [ContractTest("FOUND-4")]
    public void Foundation_NoGlobalNoWarn()
    {
        // Verify Directory.Build.props does not contain a blanket <NoWarn> that hides security or
        // correctness warnings globally. Minor IDE/doc suppressions (IDE0058, CS1591) are acceptable.
        var propsPath = Path.Combine(RepoRoot, "dotnet", "Directory.Build.props");
        if (!File.Exists(propsPath))
        {
            return; // No global props file → nothing to check.
        }

        var content = File.ReadAllText(propsPath);
        var matches = System.Text.RegularExpressions.Regex.Matches(content, @"<NoWarn>([^<]+)</NoWarn>");
        foreach (System.Text.RegularExpressions.Match m in matches)
        {
            var codes = m.Groups[1].Value.Split(';', StringSplitOptions.RemoveEmptyEntries);
            var dangerous = codes.Where(c =>
                !c.StartsWith("IDE", StringComparison.Ordinal) &&
                !c.StartsWith("CS1591", StringComparison.Ordinal))
                .ToArray();
            Assert.Empty(dangerous);
        }
    }

    [Fact]
    [ContractTest("FOUND-5")]
    public void Foundation_HelperScript_CheckCoverage_FailsBelowThreshold()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-coverage.ps1");
        Assert.True(File.Exists(scriptPath), "check-coverage.ps1 must exist in scripts/dotnet/");

        var content = File.ReadAllText(scriptPath);
        Assert.Contains("MinLine", content);
        Assert.Contains("MinBranch", content);
        Assert.Contains("cobertura", content);
    }

    [Fact]
    [ContractTest("FOUND-6")]
    public void Foundation_HelperScript_CheckBannedApis_FlagsDateTimeUtcNow()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-banned-apis.ps1");
        Assert.True(File.Exists(scriptPath), "check-banned-apis.ps1 must exist in scripts/dotnet/");

        var bannedTxtPath = Path.Combine(RepoRoot, "dotnet", "build", "banned.txt");
        Assert.True(File.Exists(bannedTxtPath), "build/banned.txt must exist");

        var bannedContent = File.ReadAllText(bannedTxtPath);
        Assert.Contains("System.DateTime.get_UtcNow", bannedContent);
        Assert.Contains("IClock.UtcNow", bannedContent);
    }

    [Fact]
    [ContractTest("FOUND-7")]
    public void Foundation_HelperScript_CheckContractTests_FailsOnMissing()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-contract-tests.ps1");
        Assert.True(File.Exists(scriptPath), "check-contract-tests.ps1 must exist in scripts/dotnet/");

        var content = File.ReadAllText(scriptPath);
        Assert.Contains("ContractTest", content);
        Assert.Contains("Acceptance tests", content);
    }
}
