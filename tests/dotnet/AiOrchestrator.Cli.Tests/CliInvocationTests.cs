// <copyright file="CliInvocationTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.CommandLine;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Cli;
using AiOrchestrator.Cli.Verbs;
using AiOrchestrator.Cli.Verbs.Daemon;
using AiOrchestrator.Cli.Verbs.Plan;
using FluentAssertions;
using Xunit;

namespace AiOrchestrator.Cli.Tests;

/// <summary>
/// Exercises every verb handler's <c>RunAsync</c> path with minimal arguments
/// so coverage reflects the real command surface (PC-6).
/// </summary>
public sealed class CliInvocationTests
{
    [Fact]
    public async Task PlanCreate_MissingName_ReturnsUsageError()
    {
        var h = new PlanCreateHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--name", string.Empty);
        code.Should().Be(CliExitCodes.UsageError);
    }

    [Fact]
    public async Task PlanCreate_WithName_ReturnsOk()
    {
        var h = new PlanCreateHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--name", "demo", "--json");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanAddJob_ReturnsOk()
    {
        var h = new PlanAddJobHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--producer-id", "j1");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanFinalize_ReturnsOk()
    {
        var h = new PlanFinalizeHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanStatus_ReturnsOk()
    {
        var h = new PlanStatusHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanStatus_Json_ReturnsOk()
    {
        var h = new PlanStatusHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--json");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanReshape_ReturnsOk()
    {
        var h = new PlanReshapeHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--op", "split");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanCancel_ReturnsCanceled()
    {
        var h = new PlanCancelHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1");
        code.Should().Be(CliExitCodes.PlanCanceled);
    }

    [Fact]
    public async Task PlanArchive_ReturnsOk()
    {
        var h = new PlanArchiveHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanDiagnose_ReturnsOk()
    {
        string tmp = CreateTempDir();
        try
        {
            var h = new PlanDiagnoseHandler(new FakeServices());
            int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--out", Path.Combine(tmp, "bundle.zip"));
            code.Should().Be(CliExitCodes.Ok);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    [Fact]
    public async Task PlanExport_ReturnsOk()
    {
        string tmp = CreateTempDir();
        try
        {
            var h = new PlanExportHandler(new FakeServices());
            int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--out", Path.Combine(tmp, "plan.json"));
            code.Should().Be(CliExitCodes.Ok);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    [Fact]
    public async Task PlanImport_ReturnsOk()
    {
        string tmp = CreateTempDir();
        try
        {
            string src = Path.Combine(tmp, "plan.json");
            await File.WriteAllTextAsync(src, "{}");
            var h = new PlanImportHandler(new FakeServices());
            int code = await InvokeWithArgsAsync(h, "--from", src);
            code.Should().Be(CliExitCodes.Ok);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    [Fact]
    public async Task DaemonStart_ReturnsDaemonUnavailable()
    {
        var h = new DaemonStartHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.DaemonUnavailable);
    }

    [Fact]
    public async Task DaemonStop_ReturnsDaemonUnavailable()
    {
        var h = new DaemonStopHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.DaemonUnavailable);
    }

    [Fact]
    public async Task DaemonStatus_ReturnsDaemonUnavailable_Human()
    {
        var h = new DaemonStatusHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.DaemonUnavailable);
    }

    [Fact]
    public async Task DaemonStatus_ReturnsDaemonUnavailable_Json()
    {
        var h = new DaemonStatusHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--json");
        code.Should().Be(CliExitCodes.DaemonUnavailable);
    }

    [Fact]
    public async Task Version_ReturnsOk_Human()
    {
        var h = new VersionHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task Version_ReturnsOk_Json()
    {
        var h = new VersionHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--json");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task HumanOutputWriter_RendersAllDtos()
    {
        string envNo = Environment.GetEnvironmentVariable("NO_COLOR") ?? string.Empty;
        var w = new HumanOutputWriter(noColorRequested: false, envNoColor: envNo);

        using var sw = new StringWriter();
        await w.WriteAsync(new VerbResult("plan status", true, "ok", 0), sw, CancellationToken.None);
        await w.WriteAsync(new VersionInfo("aio", "0.0.0", "net10.0"), sw, CancellationToken.None);
        await w.WriteAsync(new PlanStatusDto("p1", "running", 2, 3), sw, CancellationToken.None);
        await w.WriteAsync(new DaemonStatusDto(true, 123, "tcp://x"), sw, CancellationToken.None);
        await w.WriteAsync("arbitrary string", sw, CancellationToken.None);

        string output = sw.ToString();
        output.Should().Contain("plan status");
        output.Should().Contain("aio");
        output.Should().Contain("running");
        output.Should().Contain("tcp://x");
        output.Should().Contain("arbitrary string");
    }

    [Fact]
    public void HumanOutputWriter_NoColorFlag_DisablesColor()
    {
        var w = new HumanOutputWriter(noColorRequested: true, envNoColor: null);
        w.ColorEnabled.Should().BeFalse();
    }

    [Fact]
    public void HumanOutputWriter_NoColorEnv_DisablesColor()
    {
        var w = new HumanOutputWriter(noColorRequested: false, envNoColor: "1");
        w.ColorEnabled.Should().BeFalse();
    }

    [Fact]
    public async Task JsonOutputWriter_WritesSourceGenJson()
    {
        var w = new JsonOutputWriter();
        using var sw = new StringWriter();
        await w.WriteAsync(
            new VerbResult("plan status", true, "ok", 0),
            sw,
            CliJsonContext.Default.VerbResult,
            CancellationToken.None);
        sw.ToString().Should().Contain("\"verb\"");
        sw.ToString().Should().Contain("plan status");
    }

    [Fact]
    public void Program_BuildCommandTree_RegistersAllGroups()
    {
        RootCommand root = Program.BuildCommandTree(new FakeServices());
        root.Subcommands.Should().Contain(c => c.Name == "plan");
        root.Subcommands.Should().Contain(c => c.Name == "daemon");
        root.Subcommands.Should().Contain(c => c.Name == "version");
    }

    [Fact]
    public void Program_Main_UnknownVerb_ReturnsNonZero()
    {
        int exit = Program.Main(new[] { "totally-unknown-verb" });
        exit.Should().NotBe(CliExitCodes.Ok);
    }

    private static async Task<int> InvokeWithArgsAsync(VerbBase handler, params string[] args)
    {
        Command cmd = handler.Build();
        // Wrap in a root so parsing is deterministic.
        var root = new RootCommand();
        root.Subcommands.Add(cmd);
        string[] full = new string[args.Length + 1];
        full[0] = cmd.Name;
        Array.Copy(args, 0, full, 1, args.Length);
        ParseResult result = root.Parse(full);
        return await handler.InvokeAsync(result, CancellationToken.None);
    }

    private static string CreateTempDir()
    {
        string baseDir = Path.Combine(AppContext.BaseDirectory, "cli-inv-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(baseDir);
        return baseDir;
    }

    private static void TryDelete(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    [Fact]
    public async Task PlanCreate_JsonOutput_ReturnsOk()
    {
        var h = new PlanCreateHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--name", "demo", "--json");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanAddJob_JsonOutput_ReturnsOk()
    {
        var h = new PlanAddJobHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--producer-id", "j1", "--json");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task Version_MissingArgs_ReturnsOk()
    {
        var h = new VersionHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--no-color");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task PlanReshape_JsonOutput_ReturnsOk()
    {
        var h = new PlanReshapeHandler(new FakeServices());
        int code = await InvokeWithArgsAsync(h, "--plan-id", "p1", "--op", "split", "--json", "--no-color");
        code.Should().Be(CliExitCodes.Ok);
    }

    [Fact]
    public async Task InvokeAsync_WrapsOperationCanceled_ReturnsPlanCanceled()
    {
        var h = new ThrowingHandler(new FakeServices(), new OperationCanceledException());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.PlanCanceled);
    }

    [Fact]
    public async Task InvokeAsync_WrapsUnauthorizedAccess_ReturnsPermissionDenied()
    {
        var h = new ThrowingHandler(new FakeServices(), new UnauthorizedAccessException());
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.PermissionDenied);
    }

    [Fact]
    public async Task InvokeAsync_WrapsIOException_ReturnsIoError()
    {
        var h = new ThrowingHandler(new FakeServices(), new IOException("boom"));
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.IoError);
    }

    [Fact]
    public async Task InvokeAsync_WrapsUnknown_ReturnsInternalError()
    {
        var h = new ThrowingHandler(new FakeServices(), new InvalidOperationException("x"));
        int code = await InvokeWithArgsAsync(h);
        code.Should().Be(CliExitCodes.InternalError);
    }

    [Fact]
    public void VersionHandler_VerbPath_IsVersion()
    {
        var h = new VersionHandler(new FakeServices());
        h.VerbPath.Should().Be("version");
    }

    [Fact]
    public async Task PlanCreate_WithStoreAndValidator_ReturnsOk()
    {
        var sp = new FakeServices().With(new AlwaysSafeValidator());
        var h = new PlanCreateHandler(sp);
        string tmp = CreateTempDir();
        try
        {
            int code = await InvokeWithArgsAsync(h, "--name", "demo", "--store", tmp);
            code.Should().Be(CliExitCodes.Ok);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    [Fact]
    public async Task PlanCreate_RejectedByValidator_ReturnsPermissionDenied()
    {
        var sp = new FakeServices().With(new AlwaysDenyValidator());
        var h = new PlanCreateHandler(sp);
        string tmp = CreateTempDir();
        try
        {
            int code = await InvokeWithArgsAsync(h, "--name", "demo", "--store", tmp);
            code.Should().Be(CliExitCodes.PermissionDenied);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    [Theory]
    [InlineData("plan-add-job-missing-plan")]
    [InlineData("plan-archive-missing")]
    [InlineData("plan-cancel-missing")]
    [InlineData("plan-finalize-missing")]
    [InlineData("plan-reshape-missing")]
    [InlineData("plan-run-missing")]
    [InlineData("plan-status-missing")]
    [InlineData("plan-diagnose-missing")]
    [InlineData("plan-export-missing")]
    [InlineData("plan-import-missing")]
    public async Task Handlers_MissingRequiredArg_ReturnUsageError(string which)
    {
        int code = which switch
        {
            "plan-add-job-missing-plan" => await InvokeWithArgsAsync(new PlanAddJobHandler(new FakeServices()), "--plan-id", string.Empty, "--producer-id", string.Empty),
            "plan-archive-missing" => await InvokeWithArgsAsync(new PlanArchiveHandler(new FakeServices()), "--plan-id", string.Empty),
            "plan-cancel-missing" => await InvokeWithArgsAsync(new PlanCancelHandler(new FakeServices()), "--plan-id", string.Empty),
            "plan-finalize-missing" => await InvokeWithArgsAsync(new PlanFinalizeHandler(new FakeServices()), "--plan-id", string.Empty),
            "plan-reshape-missing" => await InvokeWithArgsAsync(new PlanReshapeHandler(new FakeServices()), "--plan-id", string.Empty, "--op", string.Empty),
            "plan-run-missing" => await InvokeWithArgsAsync(new PlanRunHandler(new FakeServices()), "--plan-id", string.Empty),
            "plan-status-missing" => await InvokeWithArgsAsync(new PlanStatusHandler(new FakeServices()), "--plan-id", string.Empty),
            "plan-diagnose-missing" => await InvokeWithArgsAsync(new PlanDiagnoseHandler(new FakeServices()), "--plan-id", string.Empty, "--out", string.Empty),
            "plan-export-missing" => await InvokeWithArgsAsync(new PlanExportHandler(new FakeServices()), "--plan-id", string.Empty, "--out", string.Empty),
            "plan-import-missing" => await InvokeWithArgsAsync(new PlanImportHandler(new FakeServices()), "--from", string.Empty),
            _ => throw new InvalidOperationException(which),
        };
        code.Should().Be(CliExitCodes.UsageError);
    }

    private sealed class AlwaysSafeValidator : AiOrchestrator.Abstractions.Paths.IPathValidator
    {
        public void AssertSafe(AiOrchestrator.Models.Paths.AbsolutePath path, AiOrchestrator.Models.Paths.AbsolutePath allowedRoot)
        {
        }

        public ValueTask<Stream> OpenReadUnderRootAsync(AiOrchestrator.Models.Paths.AbsolutePath allowedRoot, AiOrchestrator.Models.Paths.RelativePath relative, CancellationToken ct)
        {
            return ValueTask.FromResult<Stream>(new MemoryStream());
        }
    }

    private sealed class AlwaysDenyValidator : AiOrchestrator.Abstractions.Paths.IPathValidator
    {
        public void AssertSafe(AiOrchestrator.Models.Paths.AbsolutePath path, AiOrchestrator.Models.Paths.AbsolutePath allowedRoot)
        {
            throw new UnauthorizedAccessException("denied");
        }

        public ValueTask<Stream> OpenReadUnderRootAsync(AiOrchestrator.Models.Paths.AbsolutePath allowedRoot, AiOrchestrator.Models.Paths.RelativePath relative, CancellationToken ct)
        {
            throw new UnauthorizedAccessException("denied");
        }
    }

    private sealed class ThrowingHandler : VerbBase
    {
        private readonly Exception ex;

        public ThrowingHandler(IServiceProvider sp, Exception ex)
            : base(sp)
        {
            this.ex = ex;
        }

        public override string VerbPath => "throw";

        protected override string Description => "Throws for test purposes.";

        protected override Task<int> RunAsync(ParseResult result, CancellationToken ct)
        {
            throw this.ex;
        }
    }

    private sealed class FakeServices : IServiceProvider
    {
        private readonly System.Collections.Generic.Dictionary<Type, object> services = new();

        public FakeServices With(object impl)
        {
            foreach (Type i in impl.GetType().GetInterfaces())
            {
                this.services[i] = impl;
            }

            return this;
        }

        public object? GetService(Type serviceType)
        {
            return this.services.TryGetValue(serviceType, out object? v) ? v : null;
        }
    }
}
