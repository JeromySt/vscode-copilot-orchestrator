// <copyright file="PowerShellHardeningTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.PowerShell;
using AiOrchestrator.Shell.Tests.Fakes;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Acceptance tests covering PS-ISO-1..5.</summary>
public class PowerShellHardeningTests
{
    [Fact]
    [ContractTest("PS-ISO-1")]
    public async Task PS_ISO_1_PowerShellArgsIncludeNoProfileAndFile()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.Pwsh, "Write-Host pwsh-iso-1");

        // Complete the fake process before the runner reaches the wait phase.
        harness.Spawner.OnSpawn = h => h.Complete(0);

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        processSpec.Executable.Should().Be("pwsh");
        processSpec.Arguments.Should().ContainInOrder("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File");
        processSpec.Arguments[^1].Should().EndWith(".ps1");
    }

    [Fact]
    [ContractTest("PS-ISO-2")]
    public async Task PS_ISO_2_ScriptPathIsSecureTempInstance()
    {
        var harness = new ShellRunnerHarness();
        var spec = harness.MakeSpec(ShellKind.PowerShell, "Write-Host hi");

        string? capturedScriptPath = null;
        harness.Spawner.OnSpawn = h =>
        {
            // Snapshot the script path before the runner disposes the SecureTempScript.
            capturedScriptPath = harness.Spawner.SpawnedSpecs.Last().Arguments[^1];
            h.Complete(0);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();
        processSpec.Executable.Should().Be("powershell");
        capturedScriptPath.Should().NotBeNull();
        capturedScriptPath!.Should().StartWith(harness.TempDir.Value);
        capturedScriptPath.Should().Contain("orca-shell-");
        capturedScriptPath.Should().EndWith(".ps1");
    }

    [Fact]
    [ContractTest("PS-ISO-4")]
    public void PS_ISO_4_ForbiddenFlagsRejectedAtBuildTime()
    {
        var builder = new PowerShellCommandLineBuilder();

        builder.ContainsForbiddenFlags(ImmutableArray.Create("-Command", "Get-Process"))
            .Should().BeTrue();
        builder.ContainsForbiddenFlags(ImmutableArray.Create("-EncodedCommand", "abc"))
            .Should().BeTrue();
        builder.ContainsForbiddenFlags(ImmutableArray.Create("-c", "Get-Process"))
            .Should().BeTrue();
        builder.ContainsForbiddenFlags(ImmutableArray.Create("-ec", "abc"))
            .Should().BeTrue();
        builder.ContainsForbiddenFlags(ImmutableArray.Create("-NoProfile", "-File", "x.ps1"))
            .Should().BeFalse();

        // The builder itself MUST never produce forbidden flags.
        var built = builder.Build(new AbsolutePath(System.IO.Path.GetTempPath()));
        builder.ContainsForbiddenFlags(built).Should().BeFalse();
        built.Should().NotContain("-Command");
        built.Should().NotContain("-EncodedCommand");
    }

    [Fact]
    [ContractTest("PS-ISO-5")]
    public async Task PS_ISO_5_EnvFlowsThroughEnvScopeNotInterpolation()
    {
        var harness = new ShellRunnerHarness();
        var env = ImmutableDictionary<string, string>.Empty
            .Add("MY_TOKEN", "supersecret")
            .Add("OTHER", "value");

        var spec = harness.MakeSpec(ShellKind.Pwsh, "Write-Host envtest") with { Env = env };

        string? scriptText = null;
        harness.Spawner.OnSpawn = h =>
        {
            // Read the script body before SecureTempScript disposes it.
            var path = harness.Spawner.SpawnedSpecs.Last().Arguments[^1];
            scriptText = File.ReadAllText(path);
            h.Complete(0);
        };

        _ = await harness.Runner.RunAsync(spec, ShellRunnerHarness.SampleCtx(), CancellationToken.None);

        var processSpec = harness.Spawner.SpawnedSpecs.Single();

        // Env passed via ProcessSpec.Environment, NOT interpolated into the script body.
        processSpec.Environment.Should().NotBeNull();
        processSpec.Environment!["MY_TOKEN"].Should().Be("supersecret");
        processSpec.Environment["OTHER"].Should().Be("value");

        // The script body file should not contain the secret value (would indicate interpolation).
        scriptText.Should().NotBeNull();
        scriptText!.Should().NotContain("supersecret");
        scriptText.Should().Be(spec.Script);
    }
}
