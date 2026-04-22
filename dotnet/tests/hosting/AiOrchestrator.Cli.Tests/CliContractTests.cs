// <copyright file="CliContractTests.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Cli;
using AiOrchestrator.Cli.Verbs;
using AiOrchestrator.Cli.Verbs.Plan;
using AiOrchestrator.Models.Paths;
using Xunit;

namespace AiOrchestrator.Cli.Tests;

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    public ContractTestAttribute(string id) => this.Id = id;

    public string Id { get; }
}

public sealed class CliContractTests
{
    private static readonly string[] ExpectedVerbs = new[]
    {
        "plan create",
        "plan add-job",
        "plan finalize",
        "plan run",
        "plan status",
        "plan reshape",
        "plan cancel",
        "plan archive",
        "plan diagnose",
        "plan export",
        "plan import",
        "daemon start",
        "daemon stop",
        "daemon status",
        "version",
    };

    private static string SnapshotName(string verbPath) => verbPath.Replace(' ', '_');

    private static string SnapshotsDir()
    {
        string? dir = AppContext.BaseDirectory;
        for (int i = 0; i < 10 && dir is not null; i++)
        {
            string candidate = Path.Combine(dir, "tests", "dotnet", "AiOrchestrator.Cli.Tests", "Snapshots");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = Path.GetDirectoryName(dir);
        }

        // fallback to the copy next to the test DLL
        return Path.Combine(AppContext.BaseDirectory, "Snapshots");
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n").Trim();

    private sealed class FakeServices : IServiceProvider
    {
        private readonly Dictionary<Type, object> map = new();

        public FakeServices Add<T>(T impl)
            where T : notnull
        {
            this.map[typeof(T)] = impl;
            return this;
        }

        public object? GetService(Type serviceType) =>
            this.map.TryGetValue(serviceType, out object? v) ? v : null;
    }

    private sealed class RecordingPathValidator : IPathValidator
    {
        public List<string> Asserted { get; } = new();

        public void AssertSafe(AbsolutePath path, AbsolutePath allowedRoot)
        {
            this.Asserted.Add(path.Value);
        }

        public ValueTask<Stream> OpenReadUnderRootAsync(AbsolutePath allowedRoot, RelativePath relative, CancellationToken ct) =>
            ValueTask.FromResult<Stream>(Stream.Null);
    }

    private sealed class StubProbe : IDaemonProbe
    {
        private readonly TerminalOutcome outcome;
        private readonly TimeSpan delay;

        public StubProbe(TerminalOutcome outcome, TimeSpan delay = default)
        {
            this.outcome = outcome;
            this.delay = delay;
        }

        public async Task<TerminalOutcome> WaitForTerminalAsync(string planId, bool detach, CancellationToken ct)
        {
            if (this.delay > TimeSpan.Zero)
            {
                await Task.Delay(this.delay, ct);
            }

            return this.outcome;
        }
    }

    // -------------------------------------------------------------------------
    // CLI-VERBS: all 15 verbs are registered and reachable from the root command
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("CLI-VERBS")]
    public void CLI_VERB_REGISTERED_All15()
    {
        var sp = new FakeServices();
        IReadOnlyList<ICliVerbHandler> handlers = Program.EnumerateHandlers(sp);
        Assert.Equal(15, handlers.Count);
        Assert.Equivalent(ExpectedVerbs, handlers.Select(h => h.VerbPath));

        RootCommand root = Program.BuildCommandTree(sp);
        var rootNames = root.Subcommands.Select(c => c.Name).ToList();
        Assert.Contains("plan", rootNames);
        Assert.Contains("daemon", rootNames);
        Assert.Contains("version", rootNames);

        Command plan = root.Subcommands.Single(c => c.Name == "plan");
        Assert.Equivalent(new[]
        {
            "create", "add-job", "finalize", "run", "status", "reshape", "cancel", "archive", "diagnose", "export", "import",
        }, plan.Subcommands.Select(c => c.Name));

        Command daemon = root.Subcommands.Single(c => c.Name == "daemon");
        Assert.Equivalent(new[] { "start", "stop", "status" }, daemon.Subcommands.Select(c => c.Name));
    }

    // -------------------------------------------------------------------------
    // CLI-HELP: every verb's RenderHelp() matches a stored snapshot
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("CLI-HELP")]
    public void CLI_VERB_HelpSnapshotsPass()
    {
        var sp = new FakeServices();
        string snapsDir = SnapshotsDir();
        Assert.True(Directory.Exists(snapsDir), $"snapshots dir must exist: {snapsDir}");

        foreach (ICliVerbHandler h in Program.EnumerateHandlers(sp))
        {
            string snap = Path.Combine(snapsDir, SnapshotName(h.VerbPath) + ".txt");
            string produced = Normalize(((VerbBase)h).RenderHelp());

            if (!File.Exists(snap) && Environment.GetEnvironmentVariable("AIO_UPDATE_SNAPSHOTS") == "1")
            {
                File.WriteAllText(snap, produced + "\n");
            }

            Assert.True(File.Exists(snap), $"snapshot for '{h.VerbPath}' must exist at {snap}");
            string stored = Normalize(File.ReadAllText(snap));
            Assert.Equal(stored, produced);
        }
    }

    // -------------------------------------------------------------------------
    // CLI-EXIT: exit codes follow CliExitCodes for each outcome
    // -------------------------------------------------------------------------
    [Theory]
    [ContractTest("CLI-EXIT")]
    [InlineData("Succeeded", CliExitCodes.Ok)]
    [InlineData("Partial", CliExitCodes.PlanPartial)]
    [InlineData("Canceled", CliExitCodes.PlanCanceled)]
    [InlineData("Failed", CliExitCodes.PlanFailed)]
    [InlineData("DaemonUnavailable", CliExitCodes.DaemonUnavailable)]
    public async Task CLI_EXITCODE_PerStatus(string outcomeName, int expectedExit)
    {
        var outcome = Enum.Parse<TerminalOutcome>(outcomeName);
        var sp = new FakeServices().Add<IDaemonProbe>(new StubProbe(outcome));
        RootCommand root = Program.BuildCommandTree(sp);
        int exit = await root.Parse(new[] { "plan", "run", "--plan-id", "p1", "--json" }).InvokeAsync();
        Assert.Equal(expectedExit, exit);
    }

    // -------------------------------------------------------------------------
    // CLI-JSON-SG: JsonOutputWriter uses source-gen metadata; no reflection fallback
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("CLI-JSON-SG")]
    public void CLI_JSON_SourceGenSerializerOnly()
    {
        string cliRoot = LocateCliSrcRoot();
        string[] cs = Directory.GetFiles(cliRoot, "*.cs", SearchOption.AllDirectories);
        var offenders = new List<string>();
        foreach (string file in cs)
        {
            string text = File.ReadAllText(file);
            // Reflection-based APIs that must not appear:
            //   JsonSerializer.Serialize(value)                          (no JsonTypeInfo / context)
            //   JsonSerializer.Serialize<T>(value)
            //   JsonSerializer.Serialize(value, options) where the second arg is JsonSerializerOptions without a context
            // Accept only calls that pass a JsonTypeInfo or a JsonSerializerContext as the 2nd argument.
            foreach (Match m in Regex.Matches(text, @"JsonSerializer\.Serialize\s*(<[^>]+>)?\s*\(([^)]*)\)"))
            {
                string args = m.Groups[2].Value;
                // crude: require the call to reference CliJsonContext or JsonTypeInfo
                if (!args.Contains("CliJsonContext", StringComparison.Ordinal) &&
                    !args.Contains("JsonTypeInfo", StringComparison.Ordinal) &&
                    !args.Contains("typeInfo", StringComparison.Ordinal))
                {
                    offenders.Add($"{file}: {m.Value}");
                }
            }
        }

        Assert.Empty(offenders);
    }

    // -------------------------------------------------------------------------
    // CLI-NOCOLOR: NO_COLOR env var and --no-color both disable color
    // -------------------------------------------------------------------------
    [Theory]
    [ContractTest("CLI-NOCOLOR")]
    [InlineData(false, null, true)]
    [InlineData(true, null, false)]
    [InlineData(false, "1", false)]
    [InlineData(false, "", true)]
    public void CLI_NO_COLOR_RespectsEnv(bool noColor, string? env, bool expectedColor)
    {
        var w = new HumanOutputWriterProbe(noColor, env);
        Assert.Equal(expectedColor, w.ColorEnabled);
    }

    // -------------------------------------------------------------------------
    // CLI-RUN-BLOCK: `plan run` blocks until terminal outcome is observed
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("CLI-RUN-BLOCK")]
    public async Task CLI_PLAN_RUN_BlocksUntilTerminal()
    {
        var probe = new StubProbe(TerminalOutcome.Succeeded, TimeSpan.FromMilliseconds(150));
        var sp = new FakeServices().Add<IDaemonProbe>(probe);
        RootCommand root = Program.BuildCommandTree(sp);
        DateTime start = DateTime.UtcNow;
        int exit = await root.Parse(new[] { "plan", "run", "--plan-id", "p", "--json" }).InvokeAsync();
        DateTime end = DateTime.UtcNow;
        Assert.Equal(CliExitCodes.Ok, exit);
        Assert.True((end - start).TotalMilliseconds >= 100, "must not return before the probe completes");
    }

    // -------------------------------------------------------------------------
    // CLI-PATH-VAL: path arguments flow through IPathValidator
    // -------------------------------------------------------------------------
    [Fact]
    [ContractTest("CLI-PATH-VAL")]
    public async Task CLI_PATH_ARG_ValidatedThroughIPathValidator()
    {
        var validator = new RecordingPathValidator();
        var sp = new FakeServices().Add<IPathValidator>(validator);
        RootCommand root = Program.BuildCommandTree(sp);

        string tmp = Path.Combine(Path.GetTempPath(), $"aio-cli-test-{Guid.NewGuid():N}");
        try
        {
            _ = Directory.CreateDirectory(tmp);
            string outFile = Path.Combine(tmp, "bundle.tgz");
            int exit = await root.Parse(new[] { "plan", "export", "--plan-id", "p1", "--out", outFile, "--json" }).InvokeAsync();
            Assert.Equal(CliExitCodes.Ok, exit);
            Assert.NotEmpty(validator.Asserted);
            Assert.EndsWith("bundle.tgz", validator.Asserted.Last());
        }
        finally
        {
            try
            {
                if (Directory.Exists(tmp))
                {
                    Directory.Delete(tmp, true);
                }
            }
            catch
            {
                // best effort
            }
        }
    }

    private static string LocateCliSrcRoot()
    {
        string? dir = AppContext.BaseDirectory;
        for (int i = 0; i < 10 && dir is not null; i++)
        {
            string candidate = Path.Combine(dir, "src", "dotnet", "AiOrchestrator.Cli");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = Path.GetDirectoryName(dir);
        }

        throw new DirectoryNotFoundException("AiOrchestrator.Cli source root not found.");
    }

    // Shadow class to access the internal HumanOutputWriter constructor & property.
    private sealed class HumanOutputWriterProbe
    {
        private readonly HumanOutputWriter inner;

        public HumanOutputWriterProbe(bool noColor, string? env)
        {
            this.inner = new HumanOutputWriter(noColor, env);
        }

        public bool ColorEnabled => this.inner.ColorEnabled;
    }
}
