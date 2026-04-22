// <copyright file="PowerShellHardeningTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.PowerShell;
using AiOrchestrator.Shell.Tests.Fakes;
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
        Assert.Equal("pwsh", processSpec.Executable);
        var args = processSpec.Arguments;
        Assert.True(
            args.IndexOf("-NoProfile") < args.IndexOf("-NonInteractive") &&
            args.IndexOf("-NonInteractive") < args.IndexOf("-ExecutionPolicy") &&
            args.IndexOf("-ExecutionPolicy") < args.IndexOf("Bypass") &&
            args.IndexOf("Bypass") < args.IndexOf("-File"));
        Assert.EndsWith(".ps1", processSpec.Arguments[^1]);
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
        Assert.Equal("powershell", processSpec.Executable);
        Assert.NotNull(capturedScriptPath);
        Assert.StartsWith(harness.TempDir.Value, capturedScriptPath!);
        Assert.Contains("orca-shell-", capturedScriptPath);
        Assert.EndsWith(".ps1", capturedScriptPath);
    }

    [Fact]
    [ContractTest("PS-ISO-4")]
    public void PS_ISO_4_ForbiddenFlagsRejectedAtBuildTime()
    {
        var builder = new PowerShellCommandLineBuilder();

        Assert.True(builder.ContainsForbiddenFlags(ImmutableArray.Create("-Command", "Get-Process")));
        Assert.True(builder.ContainsForbiddenFlags(ImmutableArray.Create("-EncodedCommand", "abc")));
        Assert.True(builder.ContainsForbiddenFlags(ImmutableArray.Create("-c", "Get-Process")));
        Assert.True(builder.ContainsForbiddenFlags(ImmutableArray.Create("-ec", "abc")));
        Assert.False(builder.ContainsForbiddenFlags(ImmutableArray.Create("-NoProfile", "-File", "x.ps1")));

        // The builder itself MUST never produce forbidden flags.
        var built = builder.Build(new AbsolutePath(System.IO.Path.GetTempPath()));
        Assert.False(builder.ContainsForbiddenFlags(built));
        Assert.DoesNotContain("-Command", built);
        Assert.DoesNotContain("-EncodedCommand", built);
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
        Assert.NotNull(processSpec.Environment);
        Assert.Equal("supersecret", processSpec.Environment!["MY_TOKEN"]);
        Assert.Equal("value", processSpec.Environment["OTHER"]);

        // The script body file should not contain the secret value (would indicate interpolation).
        Assert.NotNull(scriptText);
        Assert.DoesNotContain("supersecret", scriptText!);
        Assert.Equal(spec.Script, scriptText);
    }
}
