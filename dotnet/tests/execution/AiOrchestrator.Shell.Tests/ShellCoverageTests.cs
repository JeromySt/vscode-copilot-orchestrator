// <copyright file="ShellCoverageTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using AiOrchestrator.Models.Auth;
using AiOrchestrator.Models.Ids;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.Shell.Eventing;
using AiOrchestrator.Shell.Exceptions;
using AiOrchestrator.Shell.PowerShell;
using Xunit;

namespace AiOrchestrator.Shell.Tests;

/// <summary>Coverage tests for Shell types: options, specs, results, enums, events, exceptions, and builder.</summary>
public sealed class ShellCoverageTests
{
    // ---- ShellOptions defaults ---------------------------------------------

    [Fact]
    public void ShellOptions_DefaultTimeout_Is30Minutes()
    {
        var opts = new ShellOptions();
        Assert.Equal(TimeSpan.FromMinutes(30), opts.DefaultTimeout);
    }

    [Fact]
    public void ShellOptions_DefaultTempDir_IsNotEmpty()
    {
        var opts = new ShellOptions();
        Assert.False(string.IsNullOrEmpty(opts.TempDir.Value));
    }

    [Fact]
    public void ShellOptions_WithInit_OverridesDefaults()
    {
        var opts = new ShellOptions
        {
            DefaultTimeout = TimeSpan.FromMinutes(5),
            TempDir = new AbsolutePath("/custom/temp"),
        };
        Assert.Equal(TimeSpan.FromMinutes(5), opts.DefaultTimeout);
        Assert.Equal("/custom/temp", opts.TempDir.Value);
    }

    // ---- ShellKind enum ----------------------------------------------------

    [Theory]
    [InlineData(ShellKind.Bash, 0)]
    [InlineData(ShellKind.Sh, 1)]
    [InlineData(ShellKind.Cmd, 2)]
    [InlineData(ShellKind.PowerShell, 3)]
    [InlineData(ShellKind.Pwsh, 4)]
    public void ShellKind_HasExpectedValues(ShellKind kind, int expected)
    {
        Assert.Equal(expected, (int)kind);
    }

    [Fact]
    public void ShellKind_AllValuesAreDefined()
    {
        var values = Enum.GetValues<ShellKind>();
        Assert.Equal(5, values.Length);
    }

    // ---- ShellSpec construction --------------------------------------------

    [Fact]
    public void ShellSpec_DefaultCaptureStdoutToLineView_IsTrue()
    {
        var spec = new ShellSpec
        {
            Shell = ShellKind.Bash,
            Script = "echo hello",
            WorkingDirectory = new AbsolutePath("/tmp"),
            Env = ImmutableDictionary<string, string>.Empty,
        };
        Assert.True(spec.CaptureStdoutToLineView);
    }

    [Fact]
    public void ShellSpec_DefaultTimeout_IsNull()
    {
        var spec = new ShellSpec
        {
            Shell = ShellKind.Bash,
            Script = "echo hello",
            WorkingDirectory = new AbsolutePath("/tmp"),
            Env = ImmutableDictionary<string, string>.Empty,
        };
        Assert.Null(spec.Timeout);
    }

    [Fact]
    public void ShellSpec_AllPropertiesCanBeSet()
    {
        var env = ImmutableDictionary.CreateRange(new[]
        {
            new KeyValuePair<string, string>("FOO", "bar"),
        });

        var spec = new ShellSpec
        {
            Shell = ShellKind.Pwsh,
            Script = "Get-Process",
            WorkingDirectory = new AbsolutePath("/home/user"),
            Env = env,
            Timeout = TimeSpan.FromMinutes(10),
            CaptureStdoutToLineView = false,
        };

        Assert.Equal(ShellKind.Pwsh, spec.Shell);
        Assert.Equal("Get-Process", spec.Script);
        Assert.Equal("/home/user", spec.WorkingDirectory.Value);
        Assert.Single(spec.Env);
        Assert.Equal(TimeSpan.FromMinutes(10), spec.Timeout);
        Assert.False(spec.CaptureStdoutToLineView);
    }

    // ---- ShellRunResult construction ----------------------------------------

    [Fact]
    public void ShellRunResult_CanConstruct()
    {
        var result = new ShellRunResult
        {
            ExitCode = 0,
            Duration = TimeSpan.FromSeconds(5),
            StdoutBytes = 1024,
            StderrBytes = 0,
            TimedOut = false,
        };

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(TimeSpan.FromSeconds(5), result.Duration);
        Assert.Equal(1024, result.StdoutBytes);
        Assert.Equal(0, result.StderrBytes);
        Assert.False(result.TimedOut);
    }

    [Fact]
    public void ShellRunResult_TimedOut_HasNegativeExitCode()
    {
        var result = new ShellRunResult
        {
            ExitCode = -1,
            Duration = TimeSpan.FromMinutes(30),
            StdoutBytes = 0,
            StderrBytes = 256,
            TimedOut = true,
        };

        Assert.True(result.TimedOut);
        Assert.Equal(-1, result.ExitCode);
    }

    // ---- ShellStream enum ---------------------------------------------------

    [Theory]
    [InlineData(ShellStream.Stdout, 0)]
    [InlineData(ShellStream.Stderr, 1)]
    public void ShellStream_HasExpectedValues(ShellStream stream, int expected)
    {
        Assert.Equal(expected, (int)stream);
    }

    // ---- ShellLineEmitted ---------------------------------------------------

    [Fact]
    public void ShellLineEmitted_CanConstruct()
    {
        var line = new ShellLineEmitted
        {
            JobId = new JobId(Guid.NewGuid()),
            RunId = new RunId(Guid.NewGuid()),
            Stream = ShellStream.Stdout,
            Line = "hello world",
        };

        Assert.Equal(ShellStream.Stdout, line.Stream);
        Assert.Equal("hello world", line.Line);
    }

    [Fact]
    public void ShellLineEmitted_StderrStream()
    {
        var line = new ShellLineEmitted
        {
            JobId = new JobId(Guid.NewGuid()),
            RunId = new RunId(Guid.NewGuid()),
            Stream = ShellStream.Stderr,
            Line = "error output",
        };

        Assert.Equal(ShellStream.Stderr, line.Stream);
    }

    // ---- RunContext ----------------------------------------------------------

    [Fact]
    public void RunContext_CanConstruct()
    {
        var ctx = new RunContext
        {
            JobId = new JobId(Guid.NewGuid()),
            RunId = new RunId(Guid.NewGuid()),
            Principal = new AuthContext
            {
                PrincipalId = "user1",
                DisplayName = "User 1",
                Scopes = ImmutableArray.Create("plan.run"),
            },
        };

        Assert.NotNull(ctx.JobId);
        Assert.NotNull(ctx.RunId);
        Assert.Equal("user1", ctx.Principal.PrincipalId);
    }

    // ---- WorkingDirectoryNotFoundException ----------------------------------

    [Fact]
    public void WorkingDirectoryNotFoundException_PathCtor()
    {
        var path = new AbsolutePath("/nonexistent");
        var ex = new WorkingDirectoryNotFoundException(path);
        Assert.Contains("/nonexistent", ex.Message);
        Assert.Equal(path, ex.WorkingDirectory);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_DefaultCtor()
    {
        var ex = new WorkingDirectoryNotFoundException();
        Assert.NotNull(ex.Message);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_MessageCtor()
    {
        var ex = new WorkingDirectoryNotFoundException("custom message");
        Assert.Equal("custom message", ex.Message);
    }

    [Fact]
    public void WorkingDirectoryNotFoundException_InnerExceptionCtor()
    {
        var inner = new InvalidOperationException("inner");
        var ex = new WorkingDirectoryNotFoundException("outer", inner);
        Assert.Equal("outer", ex.Message);
        Assert.Same(inner, ex.InnerException);
    }

    // ---- PowerShellCommandLineBuilder ---------------------------------------

    [Fact]
    public void PowerShellCommandLineBuilder_Build_ProducesHardenedArgs()
    {
        var builder = new PowerShellCommandLineBuilder();
        var args = builder.Build(new AbsolutePath("/tmp/script.ps1"));

        Assert.Contains("-NoProfile", args);
        Assert.Contains("-NonInteractive", args);
        Assert.Contains("-ExecutionPolicy", args);
        Assert.Contains("Bypass", args);
        Assert.Contains("-File", args);
        Assert.Contains("/tmp/script.ps1", args);
    }

    [Fact]
    public void PowerShellCommandLineBuilder_Build_FileIsLastArg()
    {
        var builder = new PowerShellCommandLineBuilder();
        var args = builder.Build(new AbsolutePath("/tmp/test.ps1"));

        int fileIdx = args.IndexOf("-File");
        Assert.Equal(args.Length - 2, fileIdx); // -File is second-to-last, path is last
        Assert.Equal("/tmp/test.ps1", args[^1]);
    }

    [Theory]
    [InlineData("-Command")]
    [InlineData("/Command")]
    [InlineData("-c")]
    [InlineData("/c")]
    [InlineData("-EncodedCommand")]
    [InlineData("/EncodedCommand")]
    [InlineData("-e")]
    [InlineData("/e")]
    [InlineData("-ec")]
    [InlineData("/ec")]
    public void PowerShellCommandLineBuilder_ContainsForbiddenFlags_DetectsAllForbidden(string flag)
    {
        var builder = new PowerShellCommandLineBuilder();
        Assert.True(builder.ContainsForbiddenFlags(ImmutableArray.Create(flag, "value")));
    }

    [Fact]
    public void PowerShellCommandLineBuilder_ContainsForbiddenFlags_AcceptsCleanArgs()
    {
        var builder = new PowerShellCommandLineBuilder();
        Assert.False(builder.ContainsForbiddenFlags(
            ImmutableArray.Create("-NoProfile", "-NonInteractive", "-File", "script.ps1")));
    }

    [Fact]
    public void PowerShellCommandLineBuilder_Build_OutputNeverContainsForbiddenFlags()
    {
        var builder = new PowerShellCommandLineBuilder();
        var args = builder.Build(new AbsolutePath("/tmp/script.ps1"));
        Assert.False(builder.ContainsForbiddenFlags(args));
    }
}
