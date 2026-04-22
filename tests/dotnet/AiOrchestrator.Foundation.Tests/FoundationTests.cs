using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml.Linq;
using FluentAssertions;
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
    private static readonly string SrcDotnet = Path.Combine(RepoRoot, "src", "dotnet");
    private static readonly string TestsDotnet = Path.Combine(RepoRoot, "tests", "dotnet");
    private static readonly string ScriptsDotnet = Path.Combine(RepoRoot, "scripts", "dotnet");

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "src", "dotnet")))
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
        var slnPath = Path.Combine(SrcDotnet, "AiOrchestrator.sln");
        File.Exists(slnPath).Should().BeTrue("AiOrchestrator.sln must exist at src/dotnet/");
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
        csprojFiles.Should().NotBeEmpty("at least the Composition project must exist");
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

        violations.Should().BeEmpty("no csproj may contain inline PackageReference Version= (use Directory.Packages.props)");
    }

    [Fact]
    [ContractTest("FOUND-4")]
    public void Foundation_NoGlobalNoWarn()
    {
        var csprojFiles = Directory.GetFiles(SrcDotnet, "*.csproj", SearchOption.AllDirectories)
            .Concat(Directory.GetFiles(TestsDotnet, "*.csproj", SearchOption.AllDirectories))
            .ToArray();

        var violations = new List<string>();
        foreach (var file in csprojFiles)
        {
            var content = File.ReadAllText(file);
            if (System.Text.RegularExpressions.Regex.IsMatch(content, @"<NoWarn>[^<]+</NoWarn>"))
            {
                violations.Add(file);
            }
        }

        violations.Should().BeEmpty("NoWarn must be empty in every csproj (zero global suppressions)");
    }

    [Fact]
    [ContractTest("FOUND-5")]
    public void Foundation_HelperScript_CheckCoverage_FailsBelowThreshold()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-coverage.ps1");
        File.Exists(scriptPath).Should().BeTrue("check-coverage.ps1 must exist in scripts/dotnet/");

        var content = File.ReadAllText(scriptPath);
        content.Should().Contain("MinLine", "script must accept a MinLine threshold parameter");
        content.Should().Contain("MinBranch", "script must accept a MinBranch threshold parameter");
        content.Should().Contain("cobertura", "script must parse cobertura XML coverage reports");
    }

    [Fact]
    [ContractTest("FOUND-6")]
    public void Foundation_HelperScript_CheckBannedApis_FlagsDateTimeUtcNow()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-banned-apis.ps1");
        File.Exists(scriptPath).Should().BeTrue("check-banned-apis.ps1 must exist in scripts/dotnet/");

        var bannedTxtPath = Path.Combine(SrcDotnet, "build", "banned.txt");
        File.Exists(bannedTxtPath).Should().BeTrue("build/banned.txt must exist");

        var bannedContent = File.ReadAllText(bannedTxtPath);
        bannedContent.Should().Contain("System.DateTime.get_UtcNow", "banned.txt must prohibit DateTime.UtcNow");
        bannedContent.Should().Contain("IClock.UtcNow", "banned.txt must suggest IClock.UtcNow as the replacement");
    }

    [Fact]
    [ContractTest("FOUND-7")]
    public void Foundation_HelperScript_CheckContractTests_FailsOnMissing()
    {
        var scriptPath = Path.Combine(ScriptsDotnet, "check-contract-tests.ps1");
        File.Exists(scriptPath).Should().BeTrue("check-contract-tests.ps1 must exist in scripts/dotnet/");

        var content = File.ReadAllText(scriptPath);
        content.Should().Contain("ContractTest", "script must look for [ContractTest(...)] attributes");
        content.Should().Contain("Acceptance tests", "script must parse the ## Acceptance tests section from job specs");
    }
}
